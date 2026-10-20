// Marca `cargos.externo = 1` em todo cargo cujo nome contenha "externo"/
// "externa" (2026-09-21) — pedido do usuário: usuário de rede não pode
// existir pra consultor externo/técnico externo. Como os cargos foram
// importados em massa do AD (scripts/importar-cargos-ad.js), existem várias
// variações de gênero/senioridade pro mesmo cargo (ex.: "CONSULTOR EXTERNO
// DE VENDAS I", "CONSULTORA EXTERNA DE VENDAS I", "...II", "...III") —
// marcar um por um na tela seria repetitivo, então esse script casa por
// substring (case/acento-insensível) em vez de depender de nome exato.
//
// Idempotente — rodar de novo não desmarca nada nem duplica.
//
// Uso:
//   node scripts/marcar-cargos-externos.js            (mostra e já marca)
//   node scripts/marcar-cargos-externos.js --so-listar (só mostra, não grava)

const { db } = require('../src/lib/db');

const soListar = process.argv.includes('--so-listar');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const cargos = db.prepare(`SELECT id, nome, externo FROM cargos WHERE ativo = 1 ORDER BY nome COLLATE NOCASE`).all();
const combinam = cargos.filter((c) => /extern[oa]/.test(normalizar(c.nome)));

console.log(`Cargos que combinam com "externo/externa" (${combinam.length} de ${cargos.length} cargo(s) ativo(s)):`);
combinam.forEach((c) => console.log(`  - ${c.nome}${c.externo ? '  [já marcado]' : ''}`));

if (soListar) {
  console.log('\n--so-listar: nada foi gravado. Rode sem essa flag pra marcar de verdade.');
  process.exit(0);
}

const marcar = db.prepare(`UPDATE cargos SET externo = 1 WHERE id = ? AND externo = 0`);
let marcados = 0;
for (const c of combinam) {
  const info = marcar.run(c.id);
  if (info.changes) marcados++;
}

console.log(`\nMarcados agora: ${marcados}. Já estavam marcados: ${combinam.length - marcados}.`);
console.log('Confira a lista acima — se algum cargo aí NÃO deveria ser externo, desmarque pela tela Colaboradores > Cargos.');
