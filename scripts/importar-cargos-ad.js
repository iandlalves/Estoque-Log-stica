// Importa os cargos (atributo "title" do AD) de todo mundo que aparece na
// consulta LDAP (src/lib/ldap.js) e cadastra os que ainda não existem em
// `cargos` (2026-09-18) — evita digitar um por um na tela. Não mexe em
// `acesso_tomticket` nem em `cargo_sistemas` de ninguém (fica 0/vazio por
// padrão pra todo cargo novo importado) — isso continua sendo decisão de
// quem configura, feita depois pela tela de Cadastros/Colaboradores.
//
// Idempotente (usa INSERT OR IGNORE, `cargos.nome` é UNIQUE) — seguro
// rodar de novo mais pra frente se o AD ganhar cargo novo.
//
// Uso:
//   node scripts/importar-cargos-ad.js           (mostra e já cadastra)
//   node scripts/importar-cargos-ad.js --so-listar (só mostra, não grava — pra conferir antes)

require('dotenv').config({ quiet: true });
const { db } = require('../src/lib/db');
const { buscarUsuariosAD, ldapConfigurado, motivoNaoConfigurado } = require('../src/lib/ldap');

(async () => {
  if (!ldapConfigurado()) {
    console.error('Não consegui: ' + motivoNaoConfigurado());
    process.exit(1);
  }

  const soListar = process.argv.includes('--so-listar');

  let resposta;
  try {
    resposta = await buscarUsuariosAD();
  } catch (e) {
    console.error('Falha na consulta ao LDAP:', e.message);
    process.exit(1);
  }

  // Distintos, sem espaço sobrando nas pontas nem espaço duplo no meio
  // (normalização SEGURA só de espaço em branco — 2026-09-18, achado
  // testando: "AGENTE DE PRÉ-VENDAS I" e "AGENTE DE PRÉ-VENDAS  I", com
  // espaço duplo, contavam como cargos diferentes). NÃO tenta juntar
  // variação de acento/gênero/sinônimo — isso fica pra revisão manual do
  // usuário na tela, evita juntar dois cargos que na real são diferentes.
  const cargosEncontrados = [
    ...new Set(resposta.usuarios.map((u) => (u.cargo || '').trim().replace(/\s+/g, ' ')).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, 'pt-BR'));

  console.log(`Cargos distintos encontrados no AD (campo "title", ${resposta.usuarios.length} usuário(s) consultado(s)): ${cargosEncontrados.length}`);
  cargosEncontrados.forEach((c) => console.log('  -', c));

  if (soListar) {
    console.log('\n--so-listar: nada foi gravado. Rode sem essa flag pra cadastrar de verdade.');
    return;
  }

  const jaExistentes = new Set(db.prepare(`SELECT nome FROM cargos`).all().map((r) => r.nome));
  const inserir = db.prepare(`INSERT OR IGNORE INTO cargos (nome) VALUES (?)`);
  let novos = 0;
  for (const nome of cargosEncontrados) {
    if (jaExistentes.has(nome)) continue;
    inserir.run(nome);
    novos++;
  }

  console.log(`\nCadastrados agora: ${novos}. Já existiam: ${cargosEncontrados.length - novos}.`);
  console.log('Lembrete: nenhum cargo importado tem "Abre chamado no TomTicket direto" marcado nem sistema associado ainda — configure isso pela aba Colaboradores > Cargos.');
})();
