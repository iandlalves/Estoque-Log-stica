// Envio de email via Microsoft Graph API (OAuth2, client credentials) —
// usado pelo botão "Enviar resumo por email" do dashboard de Estoque e pelo
// envio semanal agendado (ver scripts/enviar-resumo-estoque.js).
//
// Por que Graph API em vez de SMTP com usuário/senha: o tenant Microsoft 365
// desta empresa não libera "senha de app" pra contas (Conditional
// Access/Security Defaults bloqueiam autenticação legada) — então SMTP AUTH
// com usuário/senha não é uma opção viável aqui. Graph API usa um App
// Registration no Entra ID (permissão de aplicativo Mail.Send) — o token
// OAuth2 é obtido com client_id + client_secret (client credentials grant),
// sem senha de mailbox nenhuma envolvida. Ver README, seção "Email do
// estoque", pro passo a passo de criar o App Registration.
//
// Usa o fetch nativo do Node (>=18) pras chamadas HTTP — sem dependência
// nova só pra isso.

const fs = require('node:fs');
const path = require('node:path');

function graphConfigurado() {
  return Boolean(
    process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET && process.env.MAIL_FROM
  );
}

async function obterToken() {
  const resp = await fetch(`https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GRAPH_CLIENT_ID,
      client_secret: process.env.GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const dados = await resp.json();
  if (!resp.ok) {
    throw new Error(`Falha ao autenticar no Entra ID: ${dados.error_description || dados.error || resp.status}`);
  }
  return dados.access_token;
}

// destinatarios/cc: opcional — passar pra sobrescrever quem recebe (usado
// pelos envios automáticos com destinatário fixo, ex.: scripts/enviar-
// resumo-estoque.js e scripts/enviar-lembrete-estoque.js). Sem isso, cai no
// comportamento de sempre: MAIL_TO do .env, sem cópia — é o que o botão
// "Enviar resumo por email agora" do dashboard continua usando.
//
// anexos (2026-09-18, e-mail de boas-vindas da aba Colaboradores):
// opcional, [{ nome, caminho }] (lê do disco) ou [{ nome, buffer, tipo }]
// (já em memória, ex. o PDF da ficha de acessos gerado na hora) — monta o
// formato de anexo do Graph (fileAttachment, contentBytes em base64).
// Passe { inline: true, contentId: 'logo' } pra uma imagem referenciada no
// HTML via <img src="cid:logo"> (assinatura embutida no corpo, não um
// anexo "de verdade" na lista de arquivos).
//
// remetente (2026-09-18): opcional — manda como esse endereço em vez do
// MAIL_FROM fixo do .env. Usado pelo e-mail de boas-vindas (Colaboradores
// > Onboarding de acessos), que deve sair da caixa de quem realmente
// clicou "Enviar", não sempre da mesma conta fixa. Só funciona se o App
// Registration tiver permissão de aplicativo Mail.Send sem
// ApplicationAccessPolicy restringindo a uma caixa só — se o Graph
// recusar, o erro devolvido já indica isso.
//
// bcc (2026-09-21): cópia oculta — usado pelo e-mail de boas-vindas pra
// avisar RH/Infra sem esses endereços aparecerem pro colaborador nem pro
// líder em cópia.
async function enviarEmail({ assunto, texto, html, destinatarios, cc, bcc, anexos, remetente }) {
  if (!graphConfigurado()) {
    throw new Error(
      'Envio de email não configurado no .env (GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET/MAIL_FROM) — ver README, seção "Email do estoque".'
    );
  }
  const to = destinatarios && destinatarios.length
    ? destinatarios
    : (process.env.MAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) {
    throw new Error('MAIL_TO não configurado no .env — defina pra quem enviar o resumo (separado por vírgula).');
  }
  const ccLimpo = (cc || []).map((s) => s.trim()).filter(Boolean);
  const bccLimpo = (bcc || []).map((s) => s.trim()).filter(Boolean);
  const caixaEnvio = remetente || process.env.MAIL_FROM;

  const anexosGraph = (anexos || []).map((a) => {
    const conteudo = a.buffer ? a.buffer : fs.readFileSync(a.caminho);
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.nome || (a.caminho ? path.basename(a.caminho) : 'anexo'),
      contentType: a.tipo || 'application/octet-stream',
      contentBytes: conteudo.toString('base64'),
      ...(a.inline ? { isInline: true, contentId: a.contentId } : {}),
    };
  });

  const token = await obterToken();
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(caixaEnvio)}/sendMail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      message: {
        subject: assunto,
        body: { contentType: 'HTML', content: html },
        toRecipients: to.map((email) => ({ emailAddress: { address: email } })),
        ...(ccLimpo.length ? { ccRecipients: ccLimpo.map((email) => ({ emailAddress: { address: email } })) } : {}),
        ...(bccLimpo.length ? { bccRecipients: bccLimpo.map((email) => ({ emailAddress: { address: email } })) } : {}),
        ...(anexosGraph.length ? { attachments: anexosGraph } : {}),
      },
      saveToSentItems: true,
    }),
  });

  if (resp.status !== 202) {
    let detalhe = `HTTP ${resp.status}`;
    try { detalhe = (await resp.json()).error?.message || detalhe; } catch (_) { /* corpo vazio ou não-JSON */ }
    throw new Error(`Falha ao enviar email via Graph API: ${detalhe}`);
  }

  return [...to, ...ccLimpo];
}

module.exports = { enviarEmail, graphConfigurado };
