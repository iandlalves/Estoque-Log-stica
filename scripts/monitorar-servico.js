// Monitor externo simples — roda via cron a cada poucos minutos, confere
// /api/saude e avisa por email só quando o estado MUDA (fora do ar →
// volta ao ar), pra não virar spam a cada checagem (2026-09-17).
//
// Motivo de existir: o systemd já reinicia o processo sozinho se ele
// morrer (Restart=on-failure), mas se ficar preso num loop de crash (como
// já aconteceu numa migração errada nesta mesma plataforma), ninguém fica
// sabendo até tentar acessar e não conseguir. Este script é o "alguém
// mais" checando de fora.
//
// Não depende do processo da aplicação estar de pé — só faz uma
// requisição HTTP simples pra ele e usa src/lib/email.js (Graph API,
// independente do servidor Express) pra avisar.
//
// Uso manual (ignora o estado salvo, sempre manda o email de teste):
//   node scripts/monitorar-servico.js --forcar

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { enviarEmail } = require('../src/lib/email');

const HEALTH_URL = process.env.MONITOR_HEALTH_URL || 'http://localhost:3000/api/saude';
const TIMEOUT_MS = 5000;
const ESTADO_PATH = path.join(__dirname, '..', 'dados', 'monitor-servico-estado.json');
// Re-alerta a cada 2h enquanto continuar fora do ar, pra não deixar
// esquecido se o primeiro email passar despercebido, mas também sem
// mandar um email a cada 5 minutos.
const REALERTA_MS = 2 * 60 * 60 * 1000;

function listaEnv(nome, padrao) {
  const bruto = process.env[nome];
  return (bruto && bruto.trim() ? bruto : padrao).split(',').map((s) => s.trim()).filter(Boolean);
}

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf-8'));
  } catch (_) {
    return { status: 'desconhecido', desdeQuando: null, ultimoAlertaEm: null };
  }
}

function salvarEstado(estado) {
  fs.mkdirSync(path.dirname(ESTADO_PATH), { recursive: true });
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));
}

async function checarSaude() {
  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(HEALTH_URL, { signal: controlador.signal });
    return resp.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

(async () => {
  const forcar = process.argv.includes('--forcar');
  const destinatarios = listaEnv('MONITOR_ALERTA_TO', 'ian.alves@telehelp.com.br');
  const agora = new Date();
  const estadoAnterior = lerEstado();
  const saudavel = await checarSaude();

  if (saudavel) {
    if (estadoAnterior.status === 'fora_do_ar') {
      const html = `<p>A Central de Infraestrutura voltou a responder normalmente (estava fora do ar desde ${estadoAnterior.desdeQuando}).</p>`;
      try {
        await enviarEmail({ assunto: 'Central de Infraestrutura: voltou ao ar', texto: html.replace(/<[^>]+>/g, ''), html, destinatarios });
        console.log('Serviço voltou ao ar — email de recuperação enviado.');
      } catch (e) {
        console.error('Serviço voltou ao ar, mas falhou ao enviar o email de recuperação:', e.message);
      }
    } else if (!forcar) {
      console.log('Serviço saudável. Nada feito.');
    }
    salvarEstado({ status: 'ok', desdeQuando: null, ultimoAlertaEm: null });
    if (!forcar) return;
  }

  if (!saudavel || forcar) {
    const jaEstavaFora = estadoAnterior.status === 'fora_do_ar';
    const ultimoAlerta = estadoAnterior.ultimoAlertaEm ? new Date(estadoAnterior.ultimoAlertaEm).getTime() : 0;
    const devePreAlertar = forcar || !jaEstavaFora || (agora.getTime() - ultimoAlerta) >= REALERTA_MS;

    const desdeQuando = jaEstavaFora ? estadoAnterior.desdeQuando : agora.toISOString();

    if (devePreAlertar) {
      const html = `<p>A Central de Infraestrutura não está respondendo em <code>${HEALTH_URL}</code> desde ${desdeQuando}.</p><p>Verifique com: <code>sudo systemctl status central-infraestrutura</code> e <code>sudo journalctl -u central-infraestrutura -n 50</code>.</p>`;
      try {
        await enviarEmail({ assunto: 'ALERTA: Central de Infraestrutura fora do ar', texto: html.replace(/<[^>]+>/g, ''), html, destinatarios });
        console.log('Serviço fora do ar — email de alerta enviado.');
        salvarEstado({ status: 'fora_do_ar', desdeQuando, ultimoAlertaEm: agora.toISOString() });
      } catch (e) {
        console.error('Serviço fora do ar, e falhou ao enviar o email de alerta:', e.message);
        salvarEstado({ status: 'fora_do_ar', desdeQuando, ultimoAlertaEm: estadoAnterior.ultimoAlertaEm });
      }
    } else {
      console.log('Serviço continua fora do ar, mas já alertado recentemente — sem novo email.');
      salvarEstado({ status: 'fora_do_ar', desdeQuando, ultimoAlertaEm: estadoAnterior.ultimoAlertaEm });
    }
  }
})();
