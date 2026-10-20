// Corrige o catálogo de servidores do CPD e semeia o catálogo de receptoras
// (2026-09-23) — a lista de servidores estava desatualizada (inserida direto
// no banco há tempos) e receptoras não tinha catálogo nenhum, só um Sim/Não
// genérico de seção. O usuário mandou a lista correta (print de tela) e as 4
// receptoras existentes. Depois desse script, a tela "Servidores/Receptoras"
// (líder/gestor) assume qualquer mudança futura, sem precisar de SQL de novo.
//
// Nunca apaga de verdade — servidor que saiu da lista é desativado
// (ativo=0), preservando o histórico de checklists antigos que o marcaram.
//
// Idempotente — rodar de novo não duplica nem desfaz nada que já esteja certo.
//
// Uso:
//   node scripts/corrigir-servidores-cpd.js             (mostra e já grava)
//   node scripts/corrigir-servidores-cpd.js --so-listar  (só mostra, não grava)

const { db } = require('../src/lib/db');

const soListar = process.argv.includes('--so-listar');

const SERVIDORES_CORRETOS = [
  'srv-masex-op',
  'srv-report-op',
  'srv-mas-op',
  'srv-est-op',
  'srv-ad-op',
  'srv-accs-op',
  'srv-pbx-op',
  'srv-radar-op',
  'SERVERBI2',
  'srv-storage-op',
  'srv-nanocomm-op',
  'srv-mqtt-op',
  'vmware1',
  'srv-surgard-dc',
  'srv-fullarm-op',
  'srv-careview-op',
  'sp01sqlbi01v',
];

const RECEPTORAS = [
  'RCVR-SYSTEMIII-OP',
  'RCVR-SYSTEMIII-DC',
  'RCVR-SYSTEMV-OP',
  'RCVR-SYSTEMV-DC',
];

function normalizar(s) {
  return (s || '').trim().toLowerCase();
}

function corrigirCatalogo(tabela, nomesCorretos) {
  const existentes = db.prepare(`SELECT id, nome, ativo FROM ${tabela}`).all();
  const existentesPorNome = new Map(existentes.map((s) => [normalizar(s.nome), s]));
  const corretosPorNome = new Set(nomesCorretos.map(normalizar));

  const desativar = existentes.filter((s) => s.ativo && !corretosPorNome.has(normalizar(s.nome)));
  const reativar = existentes.filter((s) => !s.ativo && corretosPorNome.has(normalizar(s.nome)));
  const inserir = nomesCorretos.filter((nome) => !existentesPorNome.has(normalizar(nome)));

  console.log(`\n${tabela}:`);
  console.log(`  Desativar (fora da lista nova): ${desativar.length ? desativar.map((s) => s.nome).join(', ') : '(nenhum)'}`);
  console.log(`  Reativar (já existiam inativos): ${reativar.length ? reativar.map((s) => s.nome).join(', ') : '(nenhum)'}`);
  console.log(`  Inserir (novos): ${inserir.length ? inserir.join(', ') : '(nenhum)'}`);

  if (soListar) return;

  const stmtDesativar = db.prepare(`UPDATE ${tabela} SET ativo = 0 WHERE id = ?`);
  for (const s of desativar) stmtDesativar.run(s.id);

  const stmtReativar = db.prepare(`UPDATE ${tabela} SET ativo = 1 WHERE id = ?`);
  for (const s of reativar) stmtReativar.run(s.id);

  const stmtInserir = db.prepare(`INSERT OR IGNORE INTO ${tabela} (nome, ativo) VALUES (?, 1)`);
  for (const nome of inserir) stmtInserir.run(nome);
}

corrigirCatalogo('cpd_servidores', SERVIDORES_CORRETOS);
corrigirCatalogo('cpd_receptoras', RECEPTORAS);

if (soListar) {
  console.log('\n--so-listar: nada foi gravado. Rode sem essa flag pra aplicar de verdade.');
} else {
  console.log('\nCatálogos corrigidos.');
}
