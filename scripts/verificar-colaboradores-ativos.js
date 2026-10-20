// Atualiza estoque_colaboradores.ativo cruzando contra o AD (2026-09-22) —
// quem não bate com ninguém ativo no AD (usuario, ou nome na falta dele)
// vira "arquivo morto" (ativo=0), some da aba Termos normal e aparece na
// aba Arquivo morto. Roda no import em massa de termos, e pode ser rodado
// solto de novo mais pra frente conforme mais gente for saindo da empresa
// — não faz parte deste projeto deixar isso agendado sozinho, é rodar via
// SSH quando fizer sentido.
//
// Uso:
//   node scripts/verificar-colaboradores-ativos.js

require('dotenv').config({ quiet: true });
const { db } = require('../src/lib/db');
const { buscarUsuariosAD, ldapConfigurado, motivoNaoConfigurado } = require('../src/lib/ldap');
const { verificarColaboradoresAtivos } = require('../src/lib/estoqueColaboradores');

(async () => {
  if (!ldapConfigurado()) {
    console.error('Não consegui: ' + motivoNaoConfigurado());
    process.exit(1);
  }

  let resposta;
  try {
    resposta = await buscarUsuariosAD();
  } catch (e) {
    console.error('Falha na consulta ao LDAP:', e.message);
    process.exit(1);
  }

  const resultado = verificarColaboradoresAtivos(db, resposta.usuarios);
  console.log(`Colaboradores verificados: ${resultado.verificados}`);
  console.log(`Reativados (voltaram a bater com o AD): ${resultado.ativados}`);
  console.log(`Movidos pra arquivo morto agora: ${resultado.arquivados}`);
})();
