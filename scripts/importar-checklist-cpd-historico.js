// Importa o histórico do Checklist do CPD que já existia no Microsoft
// Forms antigo, exportado como .xlsx e depois convertido pra um .json
// (ver README, seção "Checklist do CPD", sobre como gerar esse .json a
// partir do .xlsx — este script só lê o .json, não abre .xlsx direto, pra
// não precisar de uma dependência nova só pra um import de uma vez só).
//
// As fotos do formulário antigo ficaram num SharePoint que exige login da
// Microsoft — não dá pra baixar automaticamente. Cada registro migrado
// guarda o link original em foto_url_externa (a tela mostra um link em
// vez da foto embutida, ver public/app.js).
//
// Idempotente: se um registro pra essa combinação de atendente + data já
// existir, pula (não duplica ao rodar de novo por engano).
//
// Uso:
//   node scripts/importar-checklist-cpd-historico.js caminho\para\cpd-historico.json "email@do/atendente"

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const crypto = require('node:crypto');
const { db } = require('../src/lib/db');

const [, , caminhoJson, emailAtendente] = process.argv;

if (!caminhoJson || !emailAtendente) {
  console.error('Uso: node scripts/importar-checklist-cpd-historico.js <caminho.json> <email-do-atendente>');
  process.exit(1);
}

const atendente = db.prepare(`SELECT * FROM atendentes WHERE email = ?`).get(emailAtendente.trim().toLowerCase());
if (!atendente) {
  console.error(`Nenhum atendente encontrado com o email "${emailAtendente}". Cadastre-o primeiro.`);
  process.exit(1);
}

const registros = JSON.parse(fs.readFileSync(caminhoJson, 'utf-8'));

function upsertServidor(nome) {
  const existente = db.prepare(`SELECT * FROM cpd_servidores WHERE nome = ?`).get(nome);
  if (existente) return existente;
  // Nome que só aparece no histórico (já foi renomeado/retirado de uso) —
  // entra no catálogo como inativo, então não aparece na lista de "Novo
  // checklist" hoje, mas continua valendo como referência pros registros
  // antigos que o mencionam.
  const info = db.prepare(`INSERT INTO cpd_servidores (nome, ativo) VALUES (?, 0)`).run(nome);
  return db.prepare(`SELECT * FROM cpd_servidores WHERE id = ?`).get(info.lastInsertRowid);
}

const inserirExecucao = db.prepare(`
  INSERT INTO cpd_checklist_execucoes
    (atendente_id, data_registro, servidores_verificado, servidores_comentario,
     receptoras_verificado, receptoras_comentario, ar_condicionado_verificado, ar_condicionado_comentario,
     foto_url_externa, criado_em)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const vincularServidor = db.prepare(
  `INSERT OR IGNORE INTO cpd_checklist_servidores_verificados (execucao_id, servidor_id) VALUES (?, ?)`
);
const jaExiste = db.prepare(
  `SELECT id FROM cpd_checklist_execucoes WHERE atendente_id = ? AND data_registro = ?`
);

let importados = 0;
let pulados = 0;
let servidoresNovos = 0;

for (const r of registros) {
  if (jaExiste.get(atendente.id, r.dataRegistro)) {
    pulados++;
    continue;
  }

  const info = inserirExecucao.run(
    atendente.id,
    r.dataRegistro,
    r.servidoresVerificado ? 1 : 0,
    r.servidoresComentario,
    r.receptorasVerificado ? 1 : 0,
    r.receptorasComentario,
    r.arCondicionadoVerificado ? 1 : 0,
    r.arCondicionadoComentario,
    r.fotoUrlExterna,
    r.criadoEm || `${r.dataRegistro}T12:00:00.000Z`
  );

  for (const nomeServidor of r.servidoresLista || []) {
    const antes = db.prepare(`SELECT id FROM cpd_servidores WHERE nome = ?`).get(nomeServidor);
    const servidor = upsertServidor(nomeServidor);
    if (!antes) servidoresNovos++;
    vincularServidor.run(info.lastInsertRowid, servidor.id);
  }

  importados++;
}

console.log(`Importação concluída: ${importados} registro(s) novo(s), ${pulados} já existiam (pulados), ${servidoresNovos} servidor(es) novo(s) no catálogo (inativos).`);
