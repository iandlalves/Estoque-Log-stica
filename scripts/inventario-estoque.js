// Recomeça o saldo do Estoque a partir de uma contagem física (2026-10-02),
// sem perder o que está com colaboradores.
//
// O que APAGA: as linhas ENTRADA, SAIDA e DEVOLUÇÃO (legado, sem pessoa) de
// estoque_movimentacoes — o histórico "solto" de estoque que ficou bagunçado.
// O que MANTÉM: todas as linhas ENTREGA e DEVOLUCAO_COLABORADOR (equipamento
// em posse de colaborador, "Equipamentos por usuário", termos de devolução),
// e todo o resto do banco (catálogo de itens/mínimos, termos, colaboradores,
// usados, consultores, corporativos).
//
// Depois de apagar, recria UMA linha por item ("saldo inicial") pra o saldo
// calculado (mesma regra de src/lib/estoqueResumo.js: ENTRADA + DEVOLUCAO_COLABORADOR
// - SAIDA - ENTREGA) bater com a contagem física informada abaixo. Itens do
// catálogo que NÃO estão na contagem mantêm exatamente o saldo que tinham —
// EXCETO modelos de notebook (nome começando com NOTEBOOK): esses ficam em 0,
// porque a contagem informada já é o total de notebooks em estoque (2) e os
// modelos antigos só carregavam saldo distorcido (saídas semanais "pra casa"
// sem devolução registrada).
//
// Segurança: sem --aplicar só mostra o que faria (dry-run, não grava nada).
// Com --aplicar, faz um backup completo do banco (VACUUM INTO) e só então
// altera, tudo dentro de uma transação que desfaz sozinha se o saldo final
// de algum item não bater com o esperado.
//
// Uso:
//   node scripts/inventario-estoque.js                      (dry-run, banco de produção)
//   node scripts/inventario-estoque.js --aplicar            (backup + grava)
//   node scripts/inventario-estoque.js "caminho.db" [--aplicar]   (teste numa cópia)

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
const { calcularEquipamentosPorUsuario } = require('../src/lib/estoqueUsuarios');

// Contagem física de 2026-10-02 (nome no catálogo -> quantidade na prateleira).
const CONTAGEM = [
  ['DESKTOP', 3],
  ['MONITOR', 0],
  ['TECLADO', 4],
  ['MOUSES', 6],
  ['TECLADO BLUETOOTH', 2],
  ['MOUSE BLUETOOTH', 2],
  ['HEADSET ZONE 300', 8],
  ['HEADSET RJ', 4],
  ['HEADSET USB', 2],
  ['CAMERA 4K', 1],
  ['NOTEBOOK DELL PRO 14', 1],
  ['NOTEBOOK DELL LATITUDE 3420', 1],
  ['TONER W1330XZ', 1],
  ['TONER W9008MZ', 3],
  ['IMAGEM W1332AC', 1],
  ['TONER CIANO', 3],
  ['TONER MAGENTA', 1],
];

const MINIMO_ITEM_NOVO = 1;

const hoje = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());

const itensAntes = calcularItensComSaldo(db);
const itemPorChave = new Map(itensAntes.map((i) => [normKey(i.item), i]));
const contagemPorChave = new Map(CONTAGEM.map(([nome, qtd]) => [normKey(nome), qtd]));

const TIPOS_APAGAR = ['ENTRADA', 'SAIDA', 'DEVOLUÇÃO'];
const totalPorTipo = Object.fromEntries(
  db.prepare('SELECT tipo, COUNT(*) AS n FROM estoque_movimentacoes GROUP BY tipo').all().map((r) => [r.tipo, r.n])
);
const aApagar = TIPOS_APAGAR.reduce((s, t) => s + (totalPorTipo[t] || 0), 0);
const aManter = (totalPorTipo.ENTREGA || 0) + (totalPorTipo.DEVOLUCAO_COLABORADOR || 0);
const outrosTipos = Object.keys(totalPorTipo).filter((t) => ![...TIPOS_APAGAR, 'ENTREGA', 'DEVOLUCAO_COLABORADOR'].includes(t));
if (outrosTipos.length) {
  console.error(`Tipo(s) de movimentação inesperado(s): ${outrosTipos.join(', ')} — abortado, nada foi alterado.`);
  process.exit(1);
}

// Saldo que sobra só com as linhas que serão mantidas (ENTREGA/DEVOLUCAO_COLABORADOR).
const saldoRestantePorChave = new Map();
for (const m of db.prepare(`SELECT equipamento, tipo, quantidade FROM estoque_movimentacoes WHERE tipo IN ('ENTREGA','DEVOLUCAO_COLABORADOR') AND NOT (tipo = 'ENTREGA' AND afeta_saldo = 0)`).all()) {
  const chave = normKey(m.equipamento);
  const delta = m.tipo === 'DEVOLUCAO_COLABORADOR' ? m.quantidade : -m.quantidade;
  saldoRestantePorChave.set(chave, (saldoRestantePorChave.get(chave) || 0) + delta);
}

// Plano: pra cada item (existente ou novo), saldo-alvo e a linha de ajuste.
const plano = [];
for (const item of itensAntes) {
  const chave = normKey(item.item);
  const contado = contagemPorChave.has(chave);
  const notebookForaDaContagem = !contado && chave.startsWith('NOTEBOOK');
  const alvo = contado ? contagemPorChave.get(chave) : notebookForaDaContagem ? 0 : item.saldo;
  plano.push({ nome: item.item, chave, antes: item.saldo, alvo, contado, novo: false, zeradoNotebook: notebookForaDaContagem });
}
for (const [nome, qtd] of CONTAGEM) {
  if (!itemPorChave.has(normKey(nome))) {
    plano.push({ nome, chave: normKey(nome), antes: 0, alvo: qtd, contado: true, novo: true });
  }
}
for (const p of plano) {
  const restante = saldoRestantePorChave.get(p.chave) || 0;
  p.diferenca = p.alvo - restante;
}

const entregasAbertasAntes = calcularEquipamentosPorUsuario(db);
const totalEntregasAbertas = db.prepare(`SELECT COUNT(*) AS n FROM estoque_movimentacoes WHERE tipo = 'ENTREGA' AND devolvido_em IS NULL`).get().n;

console.log(`Modo: ${aplicar ? 'APLICAR (grava no banco)' : 'DRY-RUN (não grava nada)'}`);
console.log(`Linhas a APAGAR: ${aApagar} (${TIPOS_APAGAR.map((t) => `${t}: ${totalPorTipo[t] || 0}`).join(', ')})`);
console.log(`Linhas MANTIDAS (com colaboradores): ${aManter} (ENTREGA: ${totalPorTipo.ENTREGA || 0}, DEVOLUCAO_COLABORADOR: ${totalPorTipo.DEVOLUCAO_COLABORADOR || 0}) — ${totalEntregasAbertas} entrega(s) em aberto, com ${entregasAbertasAntes.length} pessoa(s)`);
console.log('');
console.log('Item'.padEnd(34), 'Saldo hoje'.padStart(10), 'Novo saldo'.padStart(11), '  Observação');
for (const p of plano.slice().sort((a, b) => Number(b.contado) - Number(a.contado) || a.nome.localeCompare(b.nome))) {
  let obs = p.novo ? 'ITEM NOVO (será criado)' : p.contado ? 'contagem' : p.zeradoNotebook ? 'notebook fora da contagem — ZERADO' : 'fora da contagem — mantém saldo';
  if (!p.contado && p.alvo < 0) obs += ' — SALDO NEGATIVO';
  console.log(p.nome.padEnd(34), String(p.antes).padStart(10), String(p.alvo).padStart(11), ' ', obs);
}
const somaNotebooks = plano.filter((p) => p.chave.startsWith('NOTEBOOK')).reduce((s, p) => s + p.alvo, 0);
console.log(`
Categoria "Notebook" do dashboard depois do ajuste: ${somaNotebooks}`);

if (!aplicar) {
  console.log('\nDry-run — nada foi gravado. Rode com --aplicar pra executar (faz backup antes).');
  process.exit(0);
}

// --- Backup (obrigatório antes de qualquer alteração) ---------------------
const arquivoDb = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main').file;
const pastaBackup = path.join(path.dirname(arquivoDb), 'backups-inventario');
fs.mkdirSync(pastaBackup, { recursive: true });
const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
const destinoBackup = path.join(pastaBackup, `pre-inventario-estoque-${carimbo}.db`);
db.exec(`VACUUM INTO '${destinoBackup.replace(/'/g, "''")}'`);
if (!fs.existsSync(destinoBackup) || fs.statSync(destinoBackup).size === 0) {
  console.error('Backup não foi gerado — abortado, nada foi alterado.');
  process.exit(1);
}
console.log(`\nBackup criado: ${destinoBackup} (${(fs.statSync(destinoBackup).size / (1024 * 1024)).toFixed(2)} MB)`);

// --- Alteração (transação) -------------------------------------------------
const inserirItem = db.prepare(`INSERT INTO estoque_itens (id, item, minimo, auto) VALUES (?, ?, ?, 0)`);
const inserirMov = db.prepare(
  `INSERT INTO estoque_movimentacoes (id, data, tipo, descricao, equipamento, quantidade) VALUES (?, ?, ?, ?, ?, ?)`
);

db.exec('BEGIN');
try {
  db.prepare(`DELETE FROM estoque_movimentacoes WHERE tipo IN ('ENTRADA','SAIDA','DEVOLUÇÃO')`).run();

  let linhasCriadas = 0;
  for (const p of plano) {
    if (p.novo) inserirItem.run(crypto.randomUUID(), p.nome, MINIMO_ITEM_NOVO);
    if (p.diferenca === 0) continue;
    inserirMov.run(
      crypto.randomUUID(),
      hoje,
      p.diferenca > 0 ? 'ENTRADA' : 'SAIDA',
      p.contado ? `Saldo inicial — inventário físico de ${hoje}` : `Saldo inicial — reset do histórico de movimentações em ${hoje}`,
      p.nome,
      Math.abs(p.diferenca)
    );
    linhasCriadas += 1;
  }

  const depois = calcularItensComSaldo(db);
  const alvoPorChave = new Map(plano.map((p) => [p.chave, p.alvo]));
  const divergencias = depois.filter((i) => alvoPorChave.get(normKey(i.item)) !== i.saldo);
  if (divergencias.length) {
    throw new Error('Saldo final diferente do esperado: ' + divergencias.map((i) => `${i.item} (esperado ${alvoPorChave.get(normKey(i.item))}, ficou ${i.saldo})`).join('; '));
  }

  const entregasAbertasDepois = db.prepare(`SELECT COUNT(*) AS n FROM estoque_movimentacoes WHERE tipo = 'ENTREGA' AND devolvido_em IS NULL`).get().n;
  const pessoasDepois = calcularEquipamentosPorUsuario(db).length;
  if (entregasAbertasDepois !== totalEntregasAbertas || pessoasDepois !== entregasAbertasAntes.length) {
    throw new Error(`Entregas em aberto mudaram (${totalEntregasAbertas} -> ${entregasAbertasDepois}; pessoas ${entregasAbertasAntes.length} -> ${pessoasDepois}).`);
  }

  db.exec('COMMIT');
  console.log(`OK — ${aApagar} linha(s) apagada(s), ${linhasCriadas} linha(s) de saldo inicial criada(s). Saldo conferido em ${depois.length} itens; ${totalEntregasAbertas} entrega(s) em aberto de ${pessoasDepois} pessoa(s) intactas.`);
  console.log(`Pra desfazer: pare o serviço, restaure ${destinoBackup} sobre ${arquivoDb} (apague os arquivos -wal/-shm) e reinicie.`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Abortado — nada foi alterado no banco (o backup acima continua disponível):', e.message);
  process.exit(1);
}
