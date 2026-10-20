// Login "Entrar com Microsoft" (OIDC, Authorization Code) via MSAL Node —
// substitui o login por senha. Reaproveita o mesmo App Registration já
// criado no Entra ID pro envio de email (ver src/lib/email.js) — só
// precisou adicionar um Redirect URI lá; os escopos usados aqui são
// diferentes (openid/profile/email, delegados, em vez de Mail.Send de
// aplicativo).
//
// Fluxo: GET /api/auth/entra/login redireciona pro Microsoft; a pessoa
// entra com a conta dela; o Microsoft redireciona de volta pra
// /api/auth/entra/callback com um código; trocamos esse código por um ID
// token pela própria MSAL (biblioteca oficial da Microsoft — ela valida
// assinatura, issuer, audience e expiração do token; não reimplementamos
// verificação de JWT na mão, que é área sensível pra acertar sozinho). O
// email desse token só vira sessão de verdade se já existir um atendente
// cadastrado com esse email (ver src/routes/auth.js) — o login Microsoft
// não cria atendente novo sozinho, só autentica quem já foi cadastrado.
//
// APP_BASE_URL fixo no .env (não construído a partir do header Host da
// requisição) de propósito — usar o Host recebido pra montar o
// redirectUri seria abrir espaço pra manipulação (Host header injection);
// o Entra também exige que o redirect URI bata exatamente com o que foi
// cadastrado no App Registration.

const crypto = require('node:crypto');
const msal = require('@azure/msal-node');

const ESCOPOS = ['openid', 'profile', 'email'];

function configurado() {
  return Boolean(
    process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET && process.env.APP_BASE_URL
  );
}

function redirectUri() {
  return `${process.env.APP_BASE_URL}/api/auth/entra/callback`;
}

let _msalApp = null;
function msalApp() {
  if (!configurado()) {
    throw new Error(
      'Login Microsoft não configurado no .env (GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET/APP_BASE_URL) — ver README, seção "Login com Microsoft".'
    );
  }
  if (!_msalApp) {
    _msalApp = new msal.ConfidentialClientApplication({
      auth: {
        clientId: process.env.GRAPH_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}`,
        clientSecret: process.env.GRAPH_CLIENT_SECRET,
      },
    });
  }
  return _msalApp;
}

function gerarState() {
  return crypto.randomBytes(16).toString('hex');
}

function gerarUrlLogin(state) {
  return msalApp().getAuthCodeUrl({
    scopes: ESCOPOS,
    redirectUri: redirectUri(),
    state,
  });
}

// Troca o código de autorização pelos tokens e devolve { email, nome }.
// preferred_username no ID token é o UPN/email da conta que logou.
async function trocarCodigoPorConta(code, state) {
  const resultado = await msalApp().acquireTokenByCode({
    code,
    scopes: ESCOPOS,
    redirectUri: redirectUri(),
    state,
  });
  const claims = resultado.idTokenClaims || {};
  const email = String(claims.preferred_username || claims.email || resultado.account?.username || '').toLowerCase();
  const nome = claims.name || resultado.account?.name || email;
  return { email, nome };
}

module.exports = { configurado, gerarState, gerarUrlLogin, trocarCodigoPorConta };
