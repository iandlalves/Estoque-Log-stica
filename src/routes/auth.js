const express = require('express');
const { gerarToken, definirCookieSessao, limparCookieSessao, lerCookies, SESSAO_DURACAO_MS } = require('../lib/auth');
const { gerarState, gerarUrlLogin, trocarCodigoPorConta } = require('../lib/authEntra');

// Cookie curto só pra checar CSRF na volta do login (proteção contra
// alguém forjar um redirect de callback com um "state" adivinhado) — 5
// min é mais que suficiente pra completar o login na tela da Microsoft.
const STATE_COOKIE = 'entra_state';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

function authRouter(db) {
  const router = express.Router();

  router.get('/entra/login', async (req, res) => {
    try {
      const state = gerarState();
      const url = await gerarUrlLogin(state);
      res.setHeader(
        'Set-Cookie',
        `${STATE_COOKIE}=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=300${COOKIE_SECURE ? '; Secure' : ''}`
      );
      res.redirect(url);
    } catch (e) {
      res.status(500).send(`Não consegui iniciar o login com a Microsoft: ${e.message}`);
    }
  });

  router.get('/entra/callback', async (req, res) => {
    const { code, state, error, error_description: erroDescricao } = req.query;
    if (error) {
      return res.status(400).send(`Login cancelado ou recusado pela Microsoft: ${erroDescricao || error}`);
    }
    const cookies = lerCookies(req);
    if (!code || !state || state !== cookies[STATE_COOKIE]) {
      return res.status(400).send('Login inválido (state não confere) — feche esta aba e tente entrar de novo.');
    }

    try {
      const { email, nome } = await trocarCodigoPorConta(code, state);
      let atendente = db.prepare(`SELECT * FROM atendentes WHERE email = ?`).get(email);

      // Autoatendimento (2026-09-02): quem loga pela primeira vez e ainda
      // não está cadastrado vira Operador sozinho, sem precisar que alguém
      // cadastre antes — é o "qualquer colaborador pode abrir um chamado".
      // Continua bloqueando quem JÁ existe mas foi desativado (ativo=0) —
      // isso é decisão deliberada de alguém, não deve reabrir sozinho.
      if (!atendente) {
        const info = db
          .prepare(`INSERT INTO atendentes (nome, email, papel) VALUES (?, ?, 'operador')`)
          .run(nome, email);
        atendente = db.prepare(`SELECT * FROM atendentes WHERE id = ?`).get(info.lastInsertRowid);
      } else if (!atendente.ativo) {
        return res
          .status(403)
          .send(`Login na Microsoft feito com sucesso (${email}), mas essa conta está desativada na Central de Infraestrutura. Peça pra um Gestor reativar em Cadastros &gt; Atendentes.`);
      }

      const token = gerarToken();
      const expiraEm = new Date(Date.now() + SESSAO_DURACAO_MS).toISOString();
      db.prepare(`INSERT INTO sessoes (token, atendente_id, expira_em) VALUES (?, ?, ?)`).run(token, atendente.id, expiraEm);
      definirCookieSessao(res, token, expiraEm);
      res.redirect('/');
    } catch (e) {
      res.status(500).send(`Falha ao concluir o login com a Microsoft: ${e.message}`);
    }
  });

  router.post('/logout', (req, res) => {
    const cookies = lerCookies(req);
    const token = cookies.sessao;
    if (token) db.prepare(`DELETE FROM sessoes WHERE token = ?`).run(token);
    limparCookieSessao(res);
    res.json({ ok: true });
  });

  // Rota de "sondagem" — checa se existe sessão válida, sem nunca responder
  // 401. Diferente das rotas protegidas por exigirLogin: aqui "não estar
  // logado" é um resultado normal (primeira visita, depois de sair), não um
  // erro — então sempre 200, com logado:true/false. Isso evita logs de erro
  // no console do navegador (que loga qualquer HTTP não-2xx automaticamente)
  // numa checagem que é rotina, não falha.
  router.get('/eu', (req, res) => {
    const cookies = lerCookies(req);
    const token = cookies.sessao;
    if (!token) return res.json({ logado: false });

    const sessao = db.prepare(`SELECT * FROM sessoes WHERE token = ?`).get(token);
    if (!sessao || sessao.expira_em < new Date().toISOString()) {
      if (sessao) db.prepare(`DELETE FROM sessoes WHERE token = ?`).run(token);
      return res.json({ logado: false });
    }

    const atendente = db.prepare(`SELECT id, nome, email, departamento_id, papel, admin_total, ativo FROM atendentes WHERE id = ?`).get(sessao.atendente_id);
    if (!atendente || !atendente.ativo) {
      return res.json({ logado: false });
    }

    const departamentosLiderados = atendente.papel === 'lider'
      ? db.prepare(`SELECT departamento_id FROM atendente_departamentos_liderados WHERE atendente_id = ?`).all(atendente.id).map((r) => r.departamento_id)
      : undefined;

    res.json({
      logado: true,
      id: atendente.id,
      nome: atendente.nome,
      email: atendente.email,
      papel: atendente.papel,
      adminTotal: !!atendente.admin_total,
      departamentoId: atendente.departamento_id,
      departamentosLiderados,
    });
  });

  return router;
}

module.exports = { authRouter };
