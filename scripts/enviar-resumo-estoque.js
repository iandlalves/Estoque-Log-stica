// Gera o resumo de estoque e envia por email — mesma lógica do botão
// "Enviar resumo por email agora" do dashboard, só que roda fora do
// servidor (linha de comando / Tarefa Agendada do Windows).
//
// Pedido explícito (2026-08-31): enviar toda sexta-feira E todo fim útil de
// mês (mesmo destinatário nos dois casos) — não só uma vez por semana fixa.
// Como o Agendador de Tarefas do Windows não tem um gatilho nativo de
// "último dia útil do mês" (só "último dia do mês", que pode cair num fim
// de semana), a tarefa agendada roda este script TODO DIA (ver
// scripts/instalar-resumo-estoque-agendado-windows.ps1) e é o próprio
// script que decide se é dia de enviar ou não — ver src/lib/diasUteis.js.
//
// Destinatário fixo (rodrigo.orsoni + suporte em cópia), configurável por
// variável de ambiente se precisar trocar sem editar código.
//
// Uso manual (ignora o dia, envia sempre — útil pra testar):
//   node scripts/enviar-resumo-estoque.js --forcar

require('dotenv').config({ quiet: true }); // quiet: evita poluir o log da tarefa agendada com o banner do dotenv
const { db } = require('../src/lib/db');
const { calcularResumoEstoque, formatarResumoEmail } = require('../src/lib/estoqueResumo');
const { enviarEmail } = require('../src/lib/email');
const { ehSextaFeira, ehUltimoDiaUtilDoMes } = require('../src/lib/diasUteis');

function listaEnv(nome, padrao) {
  const bruto = process.env[nome];
  return (bruto && bruto.trim() ? bruto : padrao).split(',').map((s) => s.trim()).filter(Boolean);
}

(async () => {
  const forcar = process.argv.includes('--forcar');
  const hoje = new Date();

  // Trava (2026-09-30) — pedido explícito do usuário depois de o envio
  // continuar disparando mesmo com pedido pra desativar: a tarefa agendada
  // que chama este script não foi encontrada/removida ainda (não sabemos
  // ao certo em qual máquina ela está registrada), então a trava fica no
  // próprio script — funciona não importa de onde a tarefa dispare.
  // RESUMO_ESTOQUE_DESATIVADO=1 no .env desliga o envio sem precisar achar
  // e remover a Tarefa Agendada. --forcar IGNORA essa trava de propósito
  // (uso manual: "quero mandar agora mesmo pra testar/conferir").
  if (!forcar && process.env.RESUMO_ESTOQUE_DESATIVADO === '1') {
    console.log('RESUMO_ESTOQUE_DESATIVADO=1 no .env — envio desativado. Nada feito.');
    return;
  }

  if (!forcar && !ehSextaFeira(hoje) && !ehUltimoDiaUtilDoMes(hoje)) {
    console.log(`Hoje (${hoje.toLocaleDateString('pt-BR')}) não é sexta-feira nem o último dia útil do mês — não é dia de enviar o resumo. Nada feito.`);
    return;
  }

  try {
    // Padrões embutidos são da Central (Infra). Numa instância com
    // APP_MODULOS definido (ex.: só Estoque, de outro departamento) não há
    // padrão — sem RESUMO_ESTOQUE_TO cai no MAIL_TO da própria instância.
    const daCentral = !process.env.APP_MODULOS;
    const destinatarios = listaEnv('RESUMO_ESTOQUE_TO', daCentral ? 'rodrigo.orsoni@telehelp.com.br' : '');
    const cc = listaEnv('RESUMO_ESTOQUE_CC', daCentral ? 'suporte@telehelp.com.br' : '');
    const resumo = calcularResumoEstoque(db);
    const { assunto, texto, html } = formatarResumoEmail(resumo);
    const enviadoPara = await enviarEmail({ assunto, texto, html, destinatarios, cc });
    console.log(`Resumo de estoque (${resumo.itensComprar.length} item(ns) precisando comprar) enviado para: ${enviadoPara.join(', ')}`);
  } catch (e) {
    console.error('Falha ao enviar o resumo de estoque:', e.message);
    process.exit(1);
  }
})();
