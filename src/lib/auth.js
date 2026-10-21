// Sessão guardada no banco, cookie com token opaco (não é JWT — só uma
// chave pra tabela sessoes, dá pra "deslogar de verdade" apagando a linha).
// Quem autentica de verdade é o Microsoft Entra ID (ver src/lib/authEntra.js
// e src/routes/auth.js) — aqui só sobrou o que sempre foi independente do
// método de login: emissão/validação da sessão e o cookie.

const crypto = require('node:crypto');

const SESSAO_DURACAO_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
// COOKIE_NOME (2026-10-21): o navegador separa cookie por host, NÃO por
// porta — a Central (192.168.62.194) e as instâncias de Estoque
// (192.168.62.194:8443, :8444...) dividiriam o mesmo cookie "sessao", e
// entrar numa derrubaria a sessão da outra. Cada instância define o seu no
// .env (ex.: sessao_reversa); a Central continua com "sessao".
const COOKIE_NOME = process.env.COOKIE_NOME || 'sessao';

function gerarToken() {
  return crypto.randomBytes(32).toString('hex');
}

// --- Cookie (parser manual — evita adicionar cookie-parser só pra isto) ----

function lerCookies(req) {
  const cabecalho = req.headers.cookie;
  const cookies = {};
  if (!cabecalho) return cookies;
  cabecalho.split(';').forEach((parte) => {
    const idx = parte.indexOf('=');
    if (idx === -1) return;
    const chave = parte.slice(0, idx).trim();
    const valor = parte.slice(idx + 1).trim();
    cookies[chave] = decodeURIComponent(valor);
  });
  return cookies;
}

// COOKIE_SECURE controla o atributo Secure do cookie de sessão. Fica
// desligado (false) por padrão porque, nesta fase, o servidor roda em
// HTTP puro na rede interna — com Secure ligado e sem HTTPS, o navegador
// simplesmente ignora o cookie (não manda em requisição nenhuma) e
// ninguém consegue logar. Depois de colocar o Caddy na frente (ver
// README/Caddyfile), defina COOKIE_SECURE=true no .env — só DEPOIS de o
// site estar servido por HTTPS de verdade.
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

function definirCookieSessao(res, token, expiraEm) {
  const maxAgeSegundos = Math.floor((new Date(expiraEm).getTime() - Date.now()) / 1000);
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NOME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSegundos}${secure}`
  );
}

function limparCookieSessao(res) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NOME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
}

// --- Middleware --------------------------------------------------------

function exigirLogin(db) {
  return (req, res, next) => {
    const cookies = lerCookies(req);
    const token = cookies[COOKIE_NOME];
    if (!token) return res.status(401).json({ erro: 'Não autenticado.' });

    const sessao = db.prepare(`SELECT * FROM sessoes WHERE token = ?`).get(token);
    if (!sessao || sessao.expira_em < new Date().toISOString()) {
      if (sessao) db.prepare(`DELETE FROM sessoes WHERE token = ?`).run(token); // expirada, limpa
      return res.status(401).json({ erro: 'Sessão expirada ou inválida. Faça login de novo.' });
    }

    const atendente = db.prepare(`SELECT id, nome, email, departamento_id, papel, admin_total, ativo FROM atendentes WHERE id = ?`).get(sessao.atendente_id);
    if (!atendente || !atendente.ativo) {
      return res.status(401).json({ erro: 'Conta inativa.' });
    }

    req.atendente = atendente;
    next();
  };
}

// Middleware factory — só deixa passar se req.atendente.papel estiver entre
// os permitidos. Precisa vir DEPOIS de exigirLogin na cadeia (usa
// req.atendente, que só existe depois dele rodar).
// admin_total (2026-09-18) sempre passa, seja qual for a lista pedida —
// é a permissão administrativa TOTAL, independente do papel/posição da
// pessoa (ver comentário grande em prisma/schema.sql).
function exigirPapel(...papeisPermitidos) {
  return (req, res, next) => {
    if (req.atendente.admin_total) return next();
    if (!papeisPermitidos.includes(req.atendente.papel)) {
      return res.status(403).json({ erro: 'Sem permissão pra isso.' });
    }
    next();
  };
}

// Departamentos que essa pessoa pode ver/atuar, conforme o papel:
// - gestor: null = sem restrição (vê tudo, mesmo comportamento de sempre).
// - lider: o departamento de casa + o que estiver em
//   atendente_departamentos_liderados.
// - atendente: só o departamento de casa.
// - operador: lista vazia — visibilidade dele não é por departamento, é por
//   ser o próprio solicitante (ver uso em src/routes/chamados.js).
function departamentosVisiveisPor(db, atendente) {
  if (atendente.admin_total) return null; // mesmo "sem restrição" de Gestor, independente do papel
  if (atendente.papel === 'gestor') return null;
  if (atendente.papel === 'lider') {
    const liderados = db
      .prepare(`SELECT departamento_id FROM atendente_departamentos_liderados WHERE atendente_id = ?`)
      .all(atendente.id)
      .map((r) => r.departamento_id);
    return [...new Set([atendente.departamento_id, ...liderados].filter((id) => id != null))];
  }
  if (atendente.papel === 'atendente') {
    return atendente.departamento_id != null ? [atendente.departamento_id] : [];
  }
  return [];
}

module.exports = {
  SESSAO_DURACAO_MS,
  COOKIE_NOME,
  gerarToken,
  lerCookies,
  definirCookieSessao,
  limparCookieSessao,
  exigirLogin,
  exigirPapel,
  departamentosVisiveisPor,
};
