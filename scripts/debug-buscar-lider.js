// Diagnóstico pontual (2026-09-21) — usado pra descobrir por que
// resolverEmailLider (src/routes/onboarding.js) não achou o e-mail de um
// líder específico pra colocar em cópia no e-mail de boas-vindas. Busca no
// AD todo mundo cujo nome contém o texto passado (case/acento-insensível) e
// mostra o displayName exato + e-mail, pra comparar com o que está
// cadastrado no campo "Gestor" do colaborador.
//
// Uso:
//   node scripts/debug-buscar-lider.js "vanzo"

require('dotenv').config({ quiet: true });
const { buscarUsuariosAD, ldapConfigurado, motivoNaoConfigurado } = require('../src/lib/ldap');

function normalizar(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

(async () => {
  const termo = process.argv[2];
  if (!termo) {
    console.error('Uso: node scripts/debug-buscar-lider.js "parte do nome"');
    process.exit(1);
  }
  if (!ldapConfigurado()) {
    console.error('LDAP não configurado: ' + motivoNaoConfigurado());
    process.exit(1);
  }

  const { usuarios } = await buscarUsuariosAD();
  console.log(`Total de usuários retornados pelo AD: ${usuarios.length}`);

  const alvo = normalizar(termo);
  const encontrados = usuarios.filter((u) => normalizar(u.nome).includes(alvo));
  console.log(`\nCombinam com "${termo}" (${encontrados.length}):`);
  encontrados.forEach((u) => {
    console.log(`  - nome="${u.nome}" email="${u.email}" departamento="${u.departamento}"`);
  });
  if (!encontrados.length) {
    console.log('  (nenhum — a pessoa pode estar fora do OU pesquisado, sem "mail" preenchido, ou com conta desativada; ver FILTRO_USUARIOS em src/lib/ldap.js)');
  }
})();
