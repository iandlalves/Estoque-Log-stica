// Padroniza os nomes de equipamento que já estão gravados (2026-10-09) — ver
// src/lib/padronizacaoEquipamentos.js pras regras. Os próximos registros já
// são padronizados na hora de gravar; este script limpa o que veio antes
// ("Notebook", "NOTEBOOK", "Notbook", "Smartphone", service tag "----"...).
//
// Mexe em: estoque_movimentacoes (equipamento, modelo, st), o snapshot dos
// termos (estoque_termos.itens_snapshot), estoque_usados (item) e o catálogo
// (estoque_itens: junta itens que só diferem por maiúscula/acento e apaga item
// "auto" que ficou sem nenhuma movimentação depois da limpeza).
//
// Segurança: sem --aplicar só mostra o que mudaria (dry-run). Com --aplicar faz
// backup completo do banco (VACUUM INTO) antes e roda numa transação.
//
// Uso:
//   node scripts/padronizar-equipamentos.js                 (dry-run)
//   node scripts/padronizar-equipamentos.js --aplicar
//   node scripts/padronizar-equipamentos.js "caminho.db" [--aplicar]

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const caminhoDb = args.find((a) => !a.startsWith('--'));
if (caminhoDb) process.env.DATABASE_PATH = caminhoDb;

require('dotenv').config({ quiet: true });
const { db } = require('../src/lib/db');
const { calcularItensComSaldo } = require('../src/lib/estoqueResumo');
const { padronizarEquipamento, padronizarModelo, padronizarServiceTag, chave } = require('../src/lib/padronizacaoEquipamentos');

const colapsarMaiusculo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

// --- 1) Catálogo: padroniza a grafia (só maiúsculas/espaços — sem correção de
// digitação, pra não "corrigir" um item legítimo) e acha duplicados.
const itens = db.prepare(`SELECT * FROM estoque_itens ORDER BY auto, criado_em, item`).all();
const grupos = new Map();
for (const it of itens) {
  const k = chave(it.item);
  if (!grupos.has(k)) grupos.set(k, []);
  grupos.get(k).push(it);
}
const mesclarCatalogo = []; // { manter, remover[] }
const renomearCatalogo = []; // { id, de, para }
for (const lista of grupos.values()) {
  const [manter, ...resto] = lista; // não-auto e mais antigo primeiro
  const grafia = colapsarMaiusculo(manter.item);
  if (grafia !== manter.item) renomearCatalogo.push({ id: manter.id, de: manter.item, para: grafia });
  if (resto.length) mesclarCatalogo.push({ manter, remover: resto });
}
const catalogoFinal = [...grupos.values()].map((l) => colapsarMaiusculo(l[0].item));

// --- 2) Movimentações
const movs = db.prepare(`SELECT id, equipamento, modelo, st FROM estoque_movimentacoes`).all();
const mapaEquip = new Map(); // de -> para
const mudancasMov = [];
const contagemEquip = new Map(); // "de => para" -> n
let mudaModelo = 0;
let mudaSt = 0;
for (const m of movs) {
  if (!mapaEquip.has(m.equipamento)) mapaEquip.set(m.equipamento, padronizarEquipamento(m.equipamento, catalogoFinal));
  const equipamento = mapaEquip.get(m.equipamento);
  const modelo = padronizarModelo(m.modelo);
  const st = padronizarServiceTag(m.st);
  const mudou = equipamento !== m.equipamento || modelo !== (m.modelo ?? null) || st !== (m.st ?? null);
  if (!mudou) continue;
  mudancasMov.push({ id: m.id, equipamento, modelo, st });
  if (equipamento !== m.equipamento) {
    const k = `${m.equipamento} => ${equipamento}`;
    contagemEquip.set(k, (contagemEquip.get(k) || 0) + 1);
  }
  if (modelo !== (m.modelo ?? null)) mudaModelo += 1;
  if (st !== (m.st ?? null)) mudaSt += 1;
}

// --- 3) Snapshot dos termos
const termos = db.prepare(`SELECT id, itens_snapshot FROM estoque_termos`).all();
const mudancasTermo = [];
for (const t of termos) {
  let lista;
  try { lista = JSON.parse(t.itens_snapshot || '[]'); } catch (e) { continue; }
  if (!Array.isArray(lista) || !lista.length) continue;
  let alterado = false;
  const nova = lista.map((i) => {
    const equipamento = padronizarEquipamento(i.equipamento, catalogoFinal);
    const modelo = padronizarModelo(i.modelo);
    const st = padronizarServiceTag(i.st || i.numeroSerie);
    const copia = { ...i, equipamento, modelo, st };
    delete copia.numeroSerie;
    if (JSON.stringify(copia) !== JSON.stringify(i)) alterado = true;
    return copia;
  });
  if (alterado) mudancasTermo.push({ id: t.id, json: JSON.stringify(nova) });
}

// --- 4) Descarte
const usados = db.prepare(`SELECT id, item FROM estoque_usados`).all();
const mudancasUsados = usados
  .map((u) => ({ id: u.id, de: u.item, para: padronizarEquipamento(u.item, catalogoFinal) }))
  .filter((u) => u.de !== u.para);

console.log(`Modo: ${aplicar ? 'APLICAR (grava no banco)' : 'DRY-RUN (não grava nada)'}\n`);
console.log(`Movimentações: ${movs.length} | a alterar: ${mudancasMov.length} (equipamento: ${[...contagemEquip.values()].reduce((a, b) => a + b, 0)}, modelo: ${mudaModelo}, service tag: ${mudaSt})`);
console.log(`Termos com lista de equipamentos a alterar: ${mudancasTermo.length} | Descarte a alterar: ${mudancasUsados.length}`);
console.log(`Catálogo: ${renomearCatalogo.length} nome(s) a padronizar, ${mesclarCatalogo.length} grupo(s) de itens duplicados a juntar\n`);

if (contagemEquip.size) {
  console.log('Equipamentos que mudam de nome (de => para: quantas linhas):');
  for (const [k, n] of [...contagemEquip.entries()].sort()) console.log(`  ${k}: ${n}`);
  console.log('');
}
for (const m of mesclarCatalogo) console.log(`Catálogo duplicado: manter "${m.manter.item}", juntar ${m.remover.map((r) => `"${r.item}"`).join(', ')}`);
for (const u of mudancasUsados) console.log(`Descarte: "${u.de}" => "${u.para}"`);

if (!aplicar) {
  console.log('Atenção: entregas registradas com nome diferente do catálogo (ex.: "Mouse" x "MOUSES") passam a descontar do item certo, então alguns SALDOS mudam. Ordem recomendada: 1) este script, 2) reconciliar-equipamentos-termos.js, 3) inventario-estoque.js (que acerta o saldo pra contagem física).');
  console.log('\nDry-run — nada foi gravado. Rode com --aplicar pra executar (faz backup antes).');
  process.exit(0);
}
if (!mudancasMov.length && !mudancasTermo.length && !mudancasUsados.length && !renomearCatalogo.length && !mesclarCatalogo.length) {
  console.log('\nNada a padronizar.');
  process.exit(0);
}

// --- Backup
const arquivoDb = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main').file;
const pastaBackup = path.join(path.dirname(arquivoDb), 'backups-inventario');
fs.mkdirSync(pastaBackup, { recursive: true });
const destinoBackup = path.join(pastaBackup, `pre-padronizacao-equipamentos-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
db.exec(`VACUUM INTO '${destinoBackup.replace(/'/g, "''")}'`);
if (!fs.existsSync(destinoBackup) || fs.statSync(destinoBackup).size === 0) {
  console.error('Backup não foi gerado — abortado, nada foi alterado.');
  process.exit(1);
}
console.log(`\nBackup criado: ${destinoBackup} (${(fs.statSync(destinoBackup).size / (1024 * 1024)).toFixed(2)} MB)`);

const saldosAntes = new Map(calcularItensComSaldo(db).map((i) => [chave(i.item), i.saldo]));

db.exec('BEGIN');
try {
  const atualizaMov = db.prepare(`UPDATE estoque_movimentacoes SET equipamento = ?, modelo = ?, st = ? WHERE id = ?`);
  for (const m of mudancasMov) atualizaMov.run(m.equipamento, m.modelo, m.st, m.id);
  const atualizaTermo = db.prepare(`UPDATE estoque_termos SET itens_snapshot = ? WHERE id = ?`);
  for (const t of mudancasTermo) atualizaTermo.run(t.json, t.id);
  const atualizaUsado = db.prepare(`UPDATE estoque_usados SET item = ? WHERE id = ?`);
  for (const u of mudancasUsados) atualizaUsado.run(u.para, u.id);

  const renomeia = db.prepare(`UPDATE estoque_itens SET item = ? WHERE id = ?`);
  for (const r of renomearCatalogo) renomeia.run(r.para, r.id);
  for (const m of mesclarCatalogo) {
    const todos = [m.manter, ...m.remover];
    const minimo = Math.max(...todos.map((i) => i.minimo || 0));
    const statusManual = (todos.find((i) => i.status_manual && i.status_manual.trim()) || {}).status_manual || null;
    db.prepare(`UPDATE estoque_itens SET minimo = ?, status_manual = ? WHERE id = ?`).run(minimo, statusManual, m.manter.id);
    for (const r of m.remover) db.prepare(`DELETE FROM estoque_itens WHERE id = ?`).run(r.id);
  }

  // Item "auto" que ficou sem nenhuma movimentação (era só o nome digitado errado).
  const emUso = new Set(db.prepare(`SELECT equipamento FROM estoque_movimentacoes`).all().map((r) => chave(r.equipamento)));
  let autoRemovidos = 0;
  for (const it of db.prepare(`SELECT id, item FROM estoque_itens WHERE auto = 1`).all()) {
    if (!emUso.has(chave(it.item))) { db.prepare(`DELETE FROM estoque_itens WHERE id = ?`).run(it.id); autoRemovidos += 1; }
  }

  db.exec('COMMIT');
  console.log(`OK — ${mudancasMov.length} movimentação(ões), ${mudancasTermo.length} termo(s), ${mudancasUsados.length} item(ns) de descarte e ${renomearCatalogo.length + mesclarCatalogo.length} ajuste(s) de catálogo padronizados; ${autoRemovidos} item(ns) automático(s) sem uso removido(s).`);

  const depois = new Map(calcularItensComSaldo(db).map((i) => [chave(i.item), i.saldo]));
  const diffs = [...depois.entries()].filter(([k, v]) => (saldosAntes.get(k) ?? 0) !== v);
  if (diffs.length) {
    console.log('Saldos que mudaram (nomes errados agora contam no item certo) — se o inventário do estoque já tinha sido aplicado, rode inventario-estoque.js de novo pra voltar à contagem física:');
    for (const [k, v] of diffs) console.log(`  ${k}: ${saldosAntes.get(k) ?? 0} -> ${v}`);
  }
  console.log(`Pra desfazer: pare o serviço, restaure ${destinoBackup} sobre ${arquivoDb} (apague os arquivos -wal/-shm) e reinicie.`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Abortado — nada foi alterado no banco (o backup acima continua disponível):', e.message);
  process.exit(1);
}
