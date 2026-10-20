// Reconstitui "o que cada colaborador tem em mãos" a partir dos termos
// ASSINADOS já importados (origem 'sharepoint', com lista de equipamentos no
// itens_snapshot). Os importadores de termo (scripts/importar-termos-*.js)
// só gravam o termo — nunca criam as linhas ENTREGA em estoque_movimentacoes,
// que é de onde "Equipamentos por usuário" e a geração de termo (responsabilidade
// e devolução) leem o que a pessoa tem. Resultado: quem tem termo importado
// aparecia sem equipamento nenhum.
//
// Regra: pra cada colaborador ATIVO, percorre os termos importados em ordem
// de assinatura — um termo de responsabilidade coloca os itens "em posse"; um
// termo de devolução tira os itens devolvidos (casa por service tag; sem
// service tag, por equipamento+modelo). O que sobra "em posse" e ainda não
// existe no registro de entregas vira uma linha ENTREGA com afeta_saldo = 0
// (equipamento histórico: já estava fora do estoque, NÃO desconta da
// prateleira) e termo = 1 (já coberto por termo assinado). Não cria item no
// catálogo de estoque. Termos 'gerado' (pela plataforma) e 'upload' (sem lista)
// não entram: os gerados já têm suas entregas no registro; os enviados não
// trazem lista de equipamento.
//
// Idempotente: o que já está no registro (mesma service tag em qualquer
// entrega da pessoa, ou mesmo equipamento+modelo ainda em aberto) é pulado.
//
// Segurança: sem --aplicar só mostra o que faria. Com --aplicar faz backup
// completo do banco (VACUUM INTO) antes e confere que nenhum saldo de item
// mudou — se mudar, desfaz tudo.
//
// Uso:
//   node scripts/reconciliar-equipamentos-termos.js                 (dry-run)
//   node scripts/reconciliar-equipamentos-termos.js --aplicar
//   node scripts/reconciliar-equipamentos-termos.js "caminho.db" [--aplicar]

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const caminhoDb = args.find((a) => !a.startsWith('--'));
if (caminhoDb) process.env.DATABASE_PATH = caminhoDb;

require('dotenv').config({ quiet: true });
const { db } = require('../src/lib/db');
const { calcularItensComSaldo, normKey } = require('../src/lib/estoqueResumo');
const { padronizarEquipamento, padronizarModelo, padronizarServiceTag } = require('../src/lib/padronizacaoEquipamentos');

const SEM_ST = /^(N\/?A|-+|SEM.*|NAO.*|\?+)$/;

function normalizarItem(it) {
  const stBruto = String(it.st || it.numeroSerie || '').trim();
  const stChave = normKey(stBruto).replace(/\s+/g, '');
  const st = stChave && !SEM_ST.test(stChave) ? stBruto : null;
  const modelo = String(it.modelo || '').trim() || null;
  const equipamento = String(it.equipamento || '').trim();
  return {
    equipamento,
    modelo,
    st,
    stChave: st ? stChave : null,
    emChave: `${normKey(equipamento)}|${normKey(modelo || '')}`,
    quantidade: Number(it.quantidade) || 1,
  };
}

function dataDoTermo(t) {
  return String(t.data_assinatura || t.gerado_em || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
}

const colaboradores = db.prepare(`SELECT * FROM estoque_colaboradores WHERE ativo = 1 ORDER BY nome COLLATE NOCASE`).all();
const termosPorColaborador = new Map();
for (const t of db
  .prepare(`SELECT * FROM estoque_termos WHERE origem = 'sharepoint' ORDER BY COALESCE(data_assinatura, gerado_em), gerado_em`)
  .all()) {
  if (!termosPorColaborador.has(t.colaborador_id)) termosPorColaborador.set(t.colaborador_id, []);
  termosPorColaborador.get(t.colaborador_id).push(t);
}

const entregasPorPessoa = new Map();
for (const m of db.prepare(`SELECT * FROM estoque_movimentacoes WHERE tipo = 'ENTREGA' AND usuario IS NOT NULL AND TRIM(usuario) != ''`).all()) {
  const chave = normKey(m.usuario);
  if (!entregasPorPessoa.has(chave)) entregasPorPessoa.set(chave, []);
  entregasPorPessoa.get(chave).push(m);
}

const saldosAntes = new Map(calcularItensComSaldo(db).map((i) => [normKey(i.item), i.saldo]));

const aCriar = []; // { colaborador, item, data }
let termosAnalisados = 0;
let jaNoRegistro = 0;
let termosComListaIlegivel = 0;

for (const c of colaboradores) {
  const termos = termosPorColaborador.get(c.id) || [];
  if (!termos.length) continue;
  const emPosse = [];

  for (const t of termos) {
    termosAnalisados += 1;
    let itens;
    try {
      itens = JSON.parse(t.itens_snapshot || '[]').map(normalizarItem).filter((i) => i.equipamento);
    } catch (e) {
      termosComListaIlegivel += 1;
      continue;
    }
    if (t.tipo === 'devolucao') {
      for (const it of itens) {
        let idx = it.stChave ? emPosse.findIndex((p) => p.stChave === it.stChave) : -1;
        if (idx < 0) idx = emPosse.findIndex((p) => p.emChave === it.emChave);
        if (idx >= 0) emPosse.splice(idx, 1);
      }
    } else {
      for (const it of itens) {
        const jaTem = it.stChave
          ? emPosse.some((p) => p.stChave === it.stChave)
          : emPosse.some((p) => p.emChave === it.emChave);
        if (!jaTem) emPosse.push({ ...it, data: dataDoTermo(t) });
      }
    }
  }

  const ledger = entregasPorPessoa.get(normKey(c.usuario || c.nome)) || [];
  for (const it of emPosse) {
    const existe = it.stChave
      ? ledger.some((m) => normKey(m.st || '').replace(/\s+/g, '') === it.stChave)
      : ledger.some((m) => !m.devolvido_em && `${normKey(m.equipamento)}|${normKey(m.modelo || '')}` === it.emChave);
    if (existe) jaNoRegistro += 1;
    else aCriar.push({ colaborador: c, item: it });
  }
}

const pessoasAfetadas = new Map();
for (const x of aCriar) {
  const k = x.colaborador.id;
  if (!pessoasAfetadas.has(k)) pessoasAfetadas.set(k, { colaborador: x.colaborador, itens: [] });
  pessoasAfetadas.get(k).itens.push(x.item);
}

console.log(`Modo: ${aplicar ? 'APLICAR (grava no banco)' : 'DRY-RUN (não grava nada)'}`);
console.log(`Colaboradores ativos: ${colaboradores.length} | termos importados analisados: ${termosAnalisados}${termosComListaIlegivel ? ` (${termosComListaIlegivel} com lista ilegível, ignorados)` : ''}`);
console.log(`Equipamentos já presentes no registro (pulados): ${jaNoRegistro}`);
console.log(`Linhas de ENTREGA histórica a criar: ${aCriar.length}, para ${pessoasAfetadas.size} pessoa(s)\n`);

const pessoasComRepetido = [];
for (const { colaborador, itens } of pessoasAfetadas.values()) {
  console.log(`${colaborador.nome}${colaborador.usuario ? ` (${colaborador.usuario})` : ''}`);
  for (const it of itens) console.log(`   + ${it.equipamento}${it.modelo ? ` ${it.modelo}` : ''}${it.st ? ` — ST ${it.st}` : ' — sem ST'}${it.quantidade > 1 ? ` x${it.quantidade}` : ''}`);
  const porTipo = new Map();
  for (const it of itens) porTipo.set(normKey(it.equipamento), (porTipo.get(normKey(it.equipamento)) || 0) + 1);
  if ([...porTipo.values()].some((n) => n > 1)) pessoasComRepetido.push(colaborador.nome);
}
if (pessoasComRepetido.length) {
  console.log(`\nREVISAR: ${pessoasComRepetido.length} pessoa(s) ficariam com 2+ equipamentos do mesmo tipo (talvez um deles já tenha sido trocado sem termo de devolução): ${pessoasComRepetido.join(', ')}`);
}

if (!aplicar) {
  console.log('\nDry-run — nada foi gravado. Rode com --aplicar pra executar (faz backup antes).');
  process.exit(0);
}
if (!aCriar.length) {
  console.log('\nNada a criar.');
  process.exit(0);
}

const arquivoDb = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main').file;
const pastaBackup = path.join(path.dirname(arquivoDb), 'backups-inventario');
fs.mkdirSync(pastaBackup, { recursive: true });
const destinoBackup = path.join(pastaBackup, `pre-reconciliacao-termos-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
db.exec(`VACUUM INTO '${destinoBackup.replace(/'/g, "''")}'`);
if (!fs.existsSync(destinoBackup) || fs.statSync(destinoBackup).size === 0) {
  console.error('Backup não foi gerado — abortado, nada foi alterado.');
  process.exit(1);
}
console.log(`\nBackup criado: ${destinoBackup} (${(fs.statSync(destinoBackup).size / (1024 * 1024)).toFixed(2)} MB)`);

const inserir = db.prepare(
  `INSERT INTO estoque_movimentacoes (id, data, tipo, descricao, equipamento, quantidade, usuario, departamento, modelo, st, termo, afeta_saldo)
   VALUES (?, ?, 'ENTREGA', ?, ?, ?, ?, ?, ?, ?, 1, 0)`
);

const catalogoNomes = db.prepare(`SELECT item FROM estoque_itens`).all().map((r) => r.item);

db.exec('BEGIN');
try {
  for (const { colaborador, item } of aCriar) {
    inserir.run(
      crypto.randomUUID(),
      item.data,
      'Equipamento de termo assinado importado (reconciliação)',
      padronizarEquipamento(item.equipamento, catalogoNomes),
      item.quantidade,
      colaborador.usuario || colaborador.nome,
      colaborador.departamento || null,
      padronizarModelo(item.modelo),
      padronizarServiceTag(item.st)
    );
  }
  const divergencias = calcularItensComSaldo(db).filter((i) => (saldosAntes.get(normKey(i.item)) || 0) !== i.saldo);
  if (divergencias.length) {
    throw new Error('Saldo de item mudou: ' + divergencias.map((i) => i.item).join(', '));
  }
  db.exec('COMMIT');
  console.log(`OK — ${aCriar.length} entrega(s) histórica(s) criada(s) para ${pessoasAfetadas.size} pessoa(s). Saldo de estoque inalterado em todos os itens.`);
  console.log(`Pra desfazer: pare o serviço, restaure ${destinoBackup} sobre ${arquivoDb} (apague os arquivos -wal/-shm) e reinicie.`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Abortado — nada foi alterado no banco (o backup acima continua disponível):', e.message);
  process.exit(1);
}
