// Cadastra (ou promove) um Gestor com "Administrador total" direto no banco
// — pro primeiro acesso de uma instância nova (2026-10-21). Numa instância
// sem o módulo Chamados (APP_MODULOS=estoque) o login com Microsoft não cria
// conta sozinho (ver src/routes/auth.js), então sem isso ninguém entraria
// pra cadastrar os outros em Cadastros > Atendentes. Seguro rodar de novo:
// se o email já existe, só garante papel gestor + admin total + ativo.
//
// Uso (na pasta da instância, como o usuário do serviço — usa o .env dela):
//   node scripts/criar-gestor.js "email@telehelp.com.br" "Nome da Pessoa"

require('dotenv').config({ quiet: true });
const { db } = require('../src/lib/db');

const email = String(process.argv[2] || '').trim().toLowerCase();
const nome = String(process.argv[3] || '').trim();

if (!email || !email.includes('@')) {
  console.error('Uso: node scripts/criar-gestor.js "email@empresa.com" "Nome da Pessoa"');
  process.exit(1);
}

// Mesmo critério do login (src/routes/auth.js), que procura por email exato.
const existente = db.prepare(`SELECT * FROM atendentes WHERE lower(email) = ?`).get(email);
if (existente) {
  db.prepare(`UPDATE atendentes SET papel = 'gestor', admin_total = 1, ativo = 1 WHERE id = ?`).run(existente.id);
  console.log(`Atendente já existia (id ${existente.id}, ${existente.email}) — agora é Gestor com Administrador total, ativo.`);
} else {
  if (!nome) {
    console.error('Email ainda não cadastrado — informe também o nome: node scripts/criar-gestor.js "email" "Nome"');
    process.exit(1);
  }
  const info = db
    .prepare(`INSERT INTO atendentes (nome, email, papel, admin_total) VALUES (?, ?, 'gestor', 1)`)
    .run(nome, email);
  console.log(`Gestor cadastrado (id ${info.lastInsertRowid}): ${nome} <${email}>.`);
}
