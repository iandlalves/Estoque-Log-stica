// Anexa (ou troca) a foto de um registro de checklist do CPD já existente —
// pra quando o checklist foi feito mas a foto certa não foi enviada. Só aponta
// foto_arquivo/foto_nome_original/foto_tipo pra um arquivo novo, copiado pra
// dados/cpd-fotos/ com nome gerado (mesmo padrão do upload da tela); não mexe
// em nenhuma resposta/comentário. A foto anterior continua no disco.
//
// Sem id, procura os registros de HOJE (horário de Brasília) do turno da
// manhã (antes das 13h, mesma regra de turnoDeExecucao em src/routes/cpd.js)
// e só aplica se achar exatamente um.
//
// Se NÃO existir registro da manhã (a tela exige foto pra salvar, então um
// checklist sem foto nunca chega a ser gravado), --criar monta o registro:
// responsável = --atendente, data = hoje, sem problema no ar-condicionado,
// todos os servidores/receptoras ativos marcados SEM comentário (comentário
// = "achei problema", ver calcularMetricasMes), foto anexada e horário de
// registro = --hora (padrão 09:00, tem que ser antes das 13h pra contar como
// manhã — é um horário informado, não o momento real em que o script roda).
//
// Sem --aplicar não grava nada.
//
// Uso:
//   node scripts/anexar-foto-checklist-cpd.js "<foto.jpg>" [--aplicar]
//   node scripts/anexar-foto-checklist-cpd.js "<foto.jpg>" --id=123 [--aplicar]
//   node scripts/anexar-foto-checklist-cpd.js "<foto.jpg>" --criar --atendente=lauan [--hora=09:00] [--aplicar]

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const idArg = (args.find((a) => a.startsWith('--id=')) || '').slice(5);
const criar = args.includes('--criar');
const atendenteArg = (args.find((a) => a.startsWith('--atendente=')) || '').slice(12);
const horaArg = (args.find((a) => a.startsWith('--hora=')) || '--hora=09:00').slice(7);
const caminhoFoto = args.find((a) => !a.startsWith('--'));
if (!caminhoFoto) {
  console.error('Uso: node scripts/anexar-foto-checklist-cpd.js "<foto.jpg>" [--id=N] [--aplicar]');
  process.exit(1);
}
if (!fs.existsSync(caminhoFoto)) {
  console.error(`Foto não encontrada: ${caminhoFoto}`);
  process.exit(1);
}

const TIPOS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const extensao = path.extname(caminhoFoto).toLowerCase();
if (!TIPOS[extensao]) {
  console.error('Formato não suportado — use JPEG, PNG ou WEBP.');
  process.exit(1);
}

require('dotenv').config({ quiet: true });
const { db } = require('../src/lib/db');

const FOTOS_DIR = process.env.CPD_FOTOS_DIR || path.join(__dirname, '..', 'dados', 'cpd-fotos');

function fusoBrasilia(iso) {
  const d = new Date(iso);
  const dataLocal = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(d);
  const hora = Number(new Date(iso).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
  const horaTexto = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(d);
  return { dataLocal, hora, horaTexto };
}

const hoje = fusoBrasilia(new Date().toISOString()).dataLocal;
const consulta = `
  SELECT e.id, e.data_registro, e.criado_em, e.foto_arquivo, e.foto_url_externa, a.nome AS atendente
  FROM cpd_checklist_execucoes e
  LEFT JOIN atendentes a ON a.id = e.atendente_id`;

let candidatos;
if (idArg) {
  candidatos = db.prepare(`${consulta} WHERE e.id = ?`).all(Number(idArg));
} else {
  candidatos = db
    .prepare(`${consulta} WHERE e.data_registro = ? ORDER BY e.criado_em`)
    .all(hoje)
    .filter((e) => fusoBrasilia(e.criado_em).hora < 13);
}

function descreverRegistro(e) {
  const { horaTexto, hora } = fusoBrasilia(e.criado_em);
  const fotoAtual = e.foto_arquivo ? `foto atual: ${e.foto_arquivo}` : e.foto_url_externa ? 'foto externa (Forms antigo)' : 'SEM foto';
  return `  #${e.id} — ${e.atendente || '?'} — registrado às ${horaTexto} (${hora < 13 ? 'manhã' : 'noite'}) — data ${e.data_registro} — ${fotoAtual}`;
}

console.log(idArg ? `Registro #${idArg}:` : `Registros de ${hoje} do turno da manhã (antes das 13h):`);
if (!candidatos.length) {
  console.log('  nenhum encontrado.');
  if (!idArg) {
    const todosHoje = db.prepare(`${consulta} WHERE e.data_registro = ? ORDER BY e.criado_em`).all(hoje);
    console.log(`\nTodos os registros com data ${hoje} (qualquer turno): ${todosHoje.length ? '' : 'nenhum'}`);
    todosHoje.forEach((e) => console.log(descreverRegistro(e)));
  }
  if (idArg || !criar) {
    console.log('\nNada a fazer. Se o checklist da manhã realmente não foi salvo, rode com --criar --atendente=<nome>.');
    process.exit(2);
  }

  if (!atendenteArg) {
    console.error('\nCom --criar, informe quem fez o checklist: --atendente=<parte do nome ou email>.');
    process.exit(1);
  }
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(horaArg) || Number(horaArg.slice(0, 2)) >= 13) {
    console.error(`\n--hora inválida ("${horaArg}") — use HH:MM antes das 13:00 (manhã).`);
    process.exit(1);
  }
  const achados = db
    .prepare(`SELECT id, nome, email FROM atendentes WHERE nome LIKE ? OR email LIKE ?`)
    .all(`%${atendenteArg}%`, `%${atendenteArg}%`);
  if (achados.length !== 1) {
    console.error(`\n--atendente="${atendenteArg}" casou com ${achados.length} pessoa(s)${achados.length ? ': ' + achados.map((a) => a.nome).join(', ') : ''} — seja mais específico.`);
    process.exit(1);
  }
  const responsavel = achados[0];
  const servidores = db.prepare(`SELECT id FROM cpd_servidores WHERE ativo = 1`).all();
  const receptoras = db.prepare(`SELECT id FROM cpd_receptoras WHERE ativo = 1`).all();
  const criadoEmIso = new Date(`${hoje}T${horaArg}:00-03:00`).toISOString();

  console.log(`\nVai CRIAR um registro: responsável ${responsavel.nome}, data ${hoje}, registrado às ${horaArg} (manhã), sem problema no ar-condicionado,`);
  console.log(`${servidores.length} servidor(es) e ${receptoras.length} receptora(s) marcados sem comentário, foto ${path.basename(caminhoFoto)}.`);
  if (!aplicar) {
    console.log('\nDry-run — nada foi gravado. Rode com --aplicar pra criar.');
    process.exit(0);
  }

  fs.mkdirSync(FOTOS_DIR, { recursive: true });
  const nomeFoto = `${crypto.randomUUID()}${extensao === '.jpeg' ? '.jpg' : extensao}`;
  fs.copyFileSync(caminhoFoto, path.join(FOTOS_DIR, nomeFoto));

  db.exec('BEGIN');
  try {
    const info = db
      .prepare(
        `INSERT INTO cpd_checklist_execucoes
           (atendente_id, data_registro, servidores_verificado, receptoras_verificado,
            ar_condicionado_verificado, ar_condicionado_problema, ar_condicionado_problema_comentario,
            foto_arquivo, foto_nome_original, foto_tipo, criado_em)
         VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?, ?, ?)`
      )
      .run(responsavel.id, hoje, servidores.length ? 1 : 0, receptoras.length ? 1 : 0, nomeFoto, path.basename(caminhoFoto), TIPOS[extensao], criadoEmIso);
    const vincS = db.prepare(`INSERT OR IGNORE INTO cpd_checklist_servidores_verificados (execucao_id, servidor_id, comentario) VALUES (?, ?, NULL)`);
    const vincR = db.prepare(`INSERT OR IGNORE INTO cpd_checklist_receptoras_verificadas (execucao_id, receptora_id, comentario) VALUES (?, ?, NULL)`);
    servidores.forEach((x) => vincS.run(info.lastInsertRowid, x.id));
    receptoras.forEach((x) => vincR.run(info.lastInsertRowid, x.id));
    db.exec('COMMIT');
    console.log(`\nOK — registro #${info.lastInsertRowid} criado (manhã de ${hoje}, ${horaArg}) com a foto ${nomeFoto}.`);
  } catch (e) {
    db.exec('ROLLBACK');
    fs.unlink(path.join(FOTOS_DIR, nomeFoto), () => {});
    console.error('Abortado — nada foi gravado:', e.message);
    process.exit(1);
  }
  process.exit(0);
}
candidatos.forEach((e) => console.log(descreverRegistro(e)));

if (candidatos.length !== 1) {
  console.log('\nMais de um registro — rode de novo com --id=N escolhendo qual.');
  process.exit(3);
}
if (!aplicar) {
  console.log('\nDry-run — nada foi gravado. Rode com --aplicar pra anexar a foto a esse registro.');
  process.exit(0);
}

const alvo = candidatos[0];
fs.mkdirSync(FOTOS_DIR, { recursive: true });
const nomeNovo = `${crypto.randomUUID()}${extensao === '.jpeg' ? '.jpg' : extensao}`;
fs.copyFileSync(caminhoFoto, path.join(FOTOS_DIR, nomeNovo));

db.prepare(`UPDATE cpd_checklist_execucoes SET foto_arquivo = ?, foto_nome_original = ?, foto_tipo = ? WHERE id = ?`)
  .run(nomeNovo, path.basename(caminhoFoto), TIPOS[extensao], alvo.id);

console.log(`\nOK — foto anexada ao registro #${alvo.id} (${nomeNovo}).${alvo.foto_arquivo ? ` A foto anterior (${alvo.foto_arquivo}) continua no disco, só deixou de ser usada.` : ''}`);
