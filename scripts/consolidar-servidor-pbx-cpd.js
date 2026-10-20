// Consolida srv-pabx-op (nome antigo, já tinha histórico de checklists) e
// srv-pbx-op (nome correto, criado do zero por scripts/corrigir-servidores-cpd.js
// sem saber que era o mesmo servidor) numa linha só (2026-09-23) — confirmado
// com o usuário que é o mesmo servidor físico e o nome certo é "srv-pbx-op".
//
// Mantém o id ANTIGO (o que já tem histórico) e só corrige o nome + reativa,
// migrando pra ele qualquer marcação que já tenha caído no id novo (linha
// duplicada some no final). Idempotente — se já foi consolidado (não existe
// mais "srv-pabx-op"), não faz nada.
//
// Uso:
//   node scripts/consolidar-servidor-pbx-cpd.js             (mostra e já grava)
//   node scripts/consolidar-servidor-pbx-cpd.js --so-listar  (só mostra, não grava)

const { db } = require('../src/lib/db');

const soListar = process.argv.includes('--so-listar');

const antigo = db.prepare(`SELECT id, nome, ativo FROM cpd_servidores WHERE nome = 'srv-pabx-op'`).get();
const novo = db.prepare(`SELECT id, nome, ativo FROM cpd_servidores WHERE nome = 'srv-pbx-op'`).get();

if (!antigo) {
  console.log('Não achei "srv-pabx-op" — já foi consolidado antes, ou nunca existiu com esse nome. Nada a fazer.');
  process.exit(0);
}
if (!novo) {
  console.log('Achei "srv-pabx-op" mas não achei "srv-pbx-op" — só renomeando/reativando o antigo.');
} else {
  const refs = db.prepare(`SELECT COUNT(*) AS n FROM cpd_checklist_servidores_verificados WHERE servidor_id = ?`).get(novo.id);
  console.log(`srv-pabx-op (id ${antigo.id}, ativo=${antigo.ativo}) <- vai virar srv-pbx-op, ativo=1`);
  console.log(`srv-pbx-op (id ${novo.id}) tem ${refs.n} referência(s) em checklists — serão migradas pro id ${antigo.id} e a linha duplicada será removida.`);
}

if (soListar) {
  console.log('\n--so-listar: nada foi gravado. Rode sem essa flag pra aplicar de verdade.');
  process.exit(0);
}

// node:sqlite (DatabaseSync) não tem um helper .transaction() como o
// better-sqlite3 — BEGIN/COMMIT/ROLLBACK manual mesmo.
db.exec('BEGIN');
try {
  if (novo) {
    const itens = db.prepare(`SELECT execucao_id, comentario FROM cpd_checklist_servidores_verificados WHERE servidor_id = ?`).all(novo.id);
    const migrar = db.prepare(`INSERT OR IGNORE INTO cpd_checklist_servidores_verificados (execucao_id, servidor_id, comentario) VALUES (?, ?, ?)`);
    for (const item of itens) migrar.run(item.execucao_id, antigo.id, item.comentario);
    db.prepare(`DELETE FROM cpd_checklist_servidores_verificados WHERE servidor_id = ?`).run(novo.id);
    db.prepare(`DELETE FROM cpd_servidores WHERE id = ?`).run(novo.id);
  }
  db.prepare(`UPDATE cpd_servidores SET nome = 'srv-pbx-op', ativo = 1 WHERE id = ?`).run(antigo.id);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

console.log('\nConsolidado.');
