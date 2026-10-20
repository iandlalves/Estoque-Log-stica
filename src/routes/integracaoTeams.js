// Abrir chamado via Microsoft Teams — primeira tentativa, pedido explícito
// (2026-09-01): via Power Automate (sem bot próprio no Teams, sem
// depender do TomTicket) — se isso não bastar, o passo seguinte seria um
// bot de verdade (Bot Framework + Azure Bot Service).
//
// Como funciona: um Fluxo do Power Automate no tenant da empresa mostra um
// Cartão Adaptável no Teams (ação "Postar um cartão adaptável e aguardar
// uma resposta"), pergunta assunto/descrição/departamento/categoria/
// prioridade/quem pediu, e chama esta rota (ação HTTP) com o que foi
// respondido. Ver README, seção "Integração com Teams", pro cartão pronto
// e o passo a passo de montar o Fluxo.
//
// Fica FORA do exigirLogin (src/server.js monta este router ANTES dele) —
// não tem sessão de navegador aqui, quem chama é o Power Automate. Protegido
// por uma chave compartilhada própria (TEAMS_INTEGRACAO_API_KEY) — trocar
// essa chave se vazar não mexe em login de ninguém.

const crypto = require('node:crypto');
const express = require('express');
const { criarChamado } = require('./chamados');

function exigirApiKeyTeams(req, res, next) {
  const chaveEsperada = process.env.TEAMS_INTEGRACAO_API_KEY;
  if (!chaveEsperada) {
    return res.status(503).json({ erro: 'Integração com Teams não configurada no servidor (defina TEAMS_INTEGRACAO_API_KEY no .env).' });
  }
  const bufEsperada = Buffer.from(chaveEsperada);
  const bufRecebida = Buffer.from(req.get('X-Api-Key') || '');
  // timingSafeEqual só aceita buffers do mesmo tamanho — por isso o "length
  // igual" checado antes, com curto-circuito (não chega a comparar bytes
  // se os tamanhos já diferem, mas isso não vaza tempo porque comparar
  // .length é O(1), não O(conteúdo)).
  const bate = bufEsperada.length === bufRecebida.length && crypto.timingSafeEqual(bufEsperada, bufRecebida);
  if (!bate) return res.status(401).json({ erro: 'Chave de API inválida.' });
  next();
}

function integracaoTeamsRouter(db) {
  const router = express.Router();

  // exigirApiKeyTeams só nessa rota específica (2º argumento), NUNCA
  // router.use(exigirApiKeyTeams) sem caminho — isso rodaria pra TODO
  // request que passa por este router, e como ele é montado em '/api' (o
  // mesmo prefixo de tudo mais), bloquearia login/sessão normal do site
  // inteiro atrás dessa chave. Bug real que aconteceu em produção
  // (2026-09-02): "Chave de API inválida" aparecendo pra usuário comum,
  // sem nada a ver com Teams — corrigido escopando pro `router.post` só.
  router.post('/integracoes/teams/chamados', exigirApiKeyTeams, (req, res) => {
    const { assunto, descricao, departamentoId, categoriaId, prioridade, solicitanteNome, solicitanteEmail } = req.body;

    if (!solicitanteNome || !solicitanteEmail) {
      return res.status(400).json({ erro: 'Informe solicitanteNome e solicitanteEmail (quem pediu, no Teams).' });
    }

    try {
      const chamado = criarChamado(db, {
        assunto,
        descricao,
        departamentoId,
        categoriaId,
        prioridade,
        solicitante: { nome: solicitanteNome, email: solicitanteEmail },
      });
      // Sem link direto pro chamado — o front-end é uma SPA sem rota por URL
      // (tudo é estado em memória, sem hash/path por tela). Devolve só o
      // link da plataforma; quem receber acha o chamado pelo protocolo, em
      // Chamados > busca.
      res.status(201).json({
        protocolo: chamado.protocolo,
        id: chamado.id,
        url: process.env.APP_BASE_URL || null,
      });
    } catch (e) {
      res.status(e.status || 500).json({ erro: e.message });
    }
  });

  return router;
}

module.exports = { integracaoTeamsRouter };
