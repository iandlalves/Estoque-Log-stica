// Lembrete de "fazer o checklist do CPD" — email simples, enviado todo dia
// útil no fim da tarde SE o checklist de hoje ainda não tiver sido feito
// (meta declarada do checklist: todo dia útil — ver src/routes/cpd.js).
// Mesmo padrão do lembrete de estoque (scripts/enviar-lembrete-estoque.js):
// a Tarefa Agendada roda isso TODO DIA e o script decide se é dia útil e se
// já foi feito ou não.
//
// Uso manual (ignora o dia/status, envia sempre — útil pra testar):
//   node scripts/enviar-lembrete-cpd.js --forcar

require('dotenv').config({ quiet: true });
const { db } = require('../src/lib/db');
const { enviarEmail } = require('../src/lib/email');
const { ehDiaUtil, carregarFeriados } = require('../src/lib/diasUteis');

function listaEnv(nome, padrao) {
  const bruto = process.env[nome];
  return (bruto && bruto.trim() ? bruto : padrao).split(',').map((s) => s.trim()).filter(Boolean);
}

(async () => {
  const forcar = process.argv.includes('--forcar');
  const hoje = new Date();
  const hojeStr = hoje.toISOString().slice(0, 10);

  if (!forcar && !ehDiaUtil(hoje, carregarFeriados(db))) {
    console.log(`Hoje (${hoje.toLocaleDateString('pt-BR')}) não é dia útil — sem lembrete de CPD hoje. Nada feito.`);
    return;
  }

  const feitoHoje = db.prepare(`SELECT COUNT(*) AS n FROM cpd_checklist_execucoes WHERE data_registro = ?`).get(hojeStr).n > 0;
  if (!forcar && feitoHoje) {
    console.log(`Checklist do CPD de hoje (${hojeStr}) já foi feito — sem lembrete. Nada feito.`);
    return;
  }

  const destinatarios = listaEnv('LEMBRETE_CPD_TO', 'ian.alves@telehelp.com.br,lauan.silva@telehelp.com.br');
  const assunto = 'Lembrete: checklist do CPD hoje';
  const texto = `Lembrete: o checklist do CPD de hoje (${hojeStr}) ainda não foi feito. Meta é todo dia útil.`;
  const html = `<p>Lembrete: o checklist do CPD de hoje (${hojeStr}) ainda não foi feito. Meta é todo dia útil.</p>`;

  try {
    const enviadoPara = await enviarEmail({ assunto, texto, html, destinatarios });
    console.log(`Lembrete de checklist do CPD enviado para: ${enviadoPara.join(', ')}`);
  } catch (e) {
    console.error('Falha ao enviar o lembrete de CPD:', e.message);
    process.exit(1);
  }
})();
