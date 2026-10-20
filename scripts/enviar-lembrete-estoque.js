// Lembrete de "bater o estoque" — email simples (não é o resumo completo),
// enviado toda sexta-feira DE MANHÃ, só pra quem faz a contagem física
// (ian.alves e lauan.silva). É separado do resumo de estoque (que sai às
// 17h, pra rodrigo.orsoni + suporte em cópia — ver
// scripts/enviar-resumo-estoque.js) justamente porque tem outro público e
// outro horário: aviso de manhã pra dar tempo de bater o estoque antes do
// resumo da tarde sair.
//
// Igual ao resumo: o Agendador de Tarefas roda isso TODO DIA de manhã (ver
// scripts/instalar-lembrete-estoque-agendado-windows.ps1) e é o script que
// decide se hoje é sexta-feira ou não.
//
// Uso manual (ignora o dia, envia sempre — útil pra testar):
//   node scripts/enviar-lembrete-estoque.js --forcar

require('dotenv').config({ quiet: true });
const { enviarEmail } = require('../src/lib/email');
const { ehSextaFeira } = require('../src/lib/diasUteis');

function listaEnv(nome, padrao) {
  const bruto = process.env[nome];
  return (bruto && bruto.trim() ? bruto : padrao).split(',').map((s) => s.trim()).filter(Boolean);
}

(async () => {
  const forcar = process.argv.includes('--forcar');
  const hoje = new Date();

  if (!forcar && !ehSextaFeira(hoje)) {
    console.log(`Hoje (${hoje.toLocaleDateString('pt-BR')}) não é sexta-feira — sem lembrete hoje. Nada feito.`);
    return;
  }

  const destinatarios = listaEnv('LEMBRETE_ESTOQUE_TO', 'ian.alves@telehelp.com.br,lauan.silva@telehelp.com.br');
  const assunto = 'Lembrete: bater o estoque hoje';
  const texto = 'Lembrete semanal: hoje é sexta-feira, não esqueçam de bater o estoque antes do resumo da tarde sair.';
  const html = `<p>Lembrete semanal: hoje é sexta-feira, não esqueçam de bater o estoque antes do resumo da tarde sair.</p>`;

  try {
    const enviadoPara = await enviarEmail({ assunto, texto, html, destinatarios });
    console.log(`Lembrete de bater o estoque enviado para: ${enviadoPara.join(', ')}`);
  } catch (e) {
    console.error('Falha ao enviar o lembrete de estoque:', e.message);
    process.exit(1);
  }
})();
