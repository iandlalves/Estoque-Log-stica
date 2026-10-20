// Endpoints de cadastro/referência: departamentos, categorias, atendentes,
// solicitantes e políticas de SLA. CRUD simples (sem exclusão de verdade —
// só marca "ativo = 0" — porque chamados antigos continuam referenciando
// essas linhas e não pode quebrar o histórico).

const express = require('express');
const { exigirPapel } = require('../lib/auth');

function referenciaRouter(db) {
  const router = express.Router();

  // --- Departamentos ---------------------------------------------------
  router.get('/departamentos', (req, res) => {
    const linhas = db.prepare(`SELECT * FROM departamentos ORDER BY nome`).all();
    res.json(linhas);
  });

  // Cadastro/edição de referência (departamento, categoria, atendente, SLA)
  // é Gestor-only (2026-09-02) — antes disso, qualquer atendente logado
  // podia criar/promover qualquer um, sem checagem nenhuma.
  router.post('/departamentos', exigirPapel('gestor'), (req, res) => {
    const { nome } = req.body;
    if (!nome || !nome.trim()) {
      return res.status(400).json({ erro: 'Informe o nome do departamento.' });
    }
    try {
      const info = db.prepare(`INSERT INTO departamentos (nome) VALUES (?)`).run(nome.trim());
      const criado = db.prepare(`SELECT * FROM departamentos WHERE id = ?`).get(info.lastInsertRowid);
      res.status(201).json(criado);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ erro: 'Já existe um departamento com esse nome.' });
      }
      throw e;
    }
  });

  // --- Categorias --------------------------------------------------------
  router.get('/categorias', (req, res) => {
    const { departamentoId } = req.query;
    const linhas = departamentoId
      ? db.prepare(`SELECT * FROM categorias WHERE departamento_id = ? ORDER BY nome`).all(departamentoId)
      : db.prepare(`SELECT * FROM categorias ORDER BY nome`).all();
    res.json(linhas);
  });

  router.post('/categorias', exigirPapel('gestor'), (req, res) => {
    const { nome, departamentoId } = req.body;
    if (!nome || !nome.trim() || !departamentoId) {
      return res.status(400).json({ erro: 'Informe nome e departamentoId.' });
    }
    try {
      const info = db
        .prepare(`INSERT INTO categorias (nome, departamento_id) VALUES (?, ?)`)
        .run(nome.trim(), departamentoId);
      const criado = db.prepare(`SELECT * FROM categorias WHERE id = ?`).get(info.lastInsertRowid);
      res.status(201).json(criado);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ erro: 'Já existe essa categoria nesse departamento.' });
      }
      throw e;
    }
  });

  // --- Feriados (2026-09-08) -----------------------------------------------
  // Calendário usado por "dia útil" (src/lib/diasUteis.js) — evita feriado
  // em dia de semana virando "falta" no painel do CPD ou disparando
  // lembrete. Sem exclusão real protegida em outro lugar do sistema (nada
  // referencia feriados.id) — dá pra apagar de verdade se cadastrar errado.
  router.get('/feriados', (req, res) => {
    res.json(db.prepare(`SELECT * FROM feriados ORDER BY data`).all());
  });

  router.post('/feriados', exigirPapel('gestor'), (req, res) => {
    const { data, nome } = req.body;
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !nome || !nome.trim()) {
      return res.status(400).json({ erro: 'Informe data (AAAA-MM-DD) e nome.' });
    }
    try {
      const info = db.prepare(`INSERT INTO feriados (data, nome) VALUES (?, ?)`).run(data, nome.trim());
      res.status(201).json(db.prepare(`SELECT * FROM feriados WHERE id = ?`).get(info.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ erro: 'Já existe um feriado cadastrado nessa data.' });
      }
      throw e;
    }
  });

  router.delete('/feriados/:id', exigirPapel('gestor'), (req, res) => {
    db.prepare(`DELETE FROM feriados WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });

  // --- Subcategorias (2026-09-03) -----------------------------------------
  router.get('/subcategorias', (req, res) => {
    const { categoriaId } = req.query;
    const linhas = categoriaId
      ? db.prepare(`SELECT * FROM subcategorias WHERE categoria_id = ? ORDER BY nome`).all(categoriaId)
      : db.prepare(`SELECT * FROM subcategorias ORDER BY nome`).all();
    res.json(linhas);
  });

  router.post('/subcategorias', exigirPapel('gestor'), (req, res) => {
    const { nome, categoriaId } = req.body;
    if (!nome || !nome.trim() || !categoriaId) {
      return res.status(400).json({ erro: 'Informe nome e categoriaId.' });
    }
    try {
      const info = db
        .prepare(`INSERT INTO subcategorias (nome, categoria_id) VALUES (?, ?)`)
        .run(nome.trim(), categoriaId);
      const criado = db.prepare(`SELECT * FROM subcategorias WHERE id = ?`).get(info.lastInsertRowid);
      res.status(201).json(criado);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ erro: 'Já existe essa subcategoria nessa categoria.' });
      }
      throw e;
    }
  });

  // --- Atendentes ----------------------------------------------------------
  router.get('/atendentes', (req, res) => {
    const linhas = db.prepare(`SELECT * FROM atendentes ORDER BY nome`).all();
    res.json(linhas);
  });

  const PAPEIS_VALIDOS = ['operador', 'atendente', 'lider', 'gestor'];

  router.post('/atendentes', exigirPapel('gestor'), (req, res) => {
    const { nome, email, departamentoId, papel = 'atendente', adminTotal = false } = req.body;
    if (!nome || !nome.trim() || !email || !email.trim()) {
      return res.status(400).json({ erro: 'Informe nome e email.' });
    }
    if (!PAPEIS_VALIDOS.includes(papel)) {
      return res.status(400).json({ erro: `Papel inválido. Use um de: ${PAPEIS_VALIDOS.join(', ')}.` });
    }
    try {
      const info = db
        .prepare(`INSERT INTO atendentes (nome, email, departamento_id, papel, admin_total) VALUES (?, ?, ?, ?, ?)`)
        .run(nome.trim(), email.trim().toLowerCase(), departamentoId || null, papel, adminTotal ? 1 : 0);
      const criado = db.prepare(`SELECT * FROM atendentes WHERE id = ?`).get(info.lastInsertRowid);
      res.status(201).json(criado);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ erro: 'Já existe um atendente com esse email.' });
      }
      throw e;
    }
  });

  // Editar papel/departamento/ativo de quem já existe — antes só dava pra
  // criar, nunca editar (não tinha necessidade até papel existir).
  router.patch('/atendentes/:id', exigirPapel('gestor'), (req, res) => {
    const existente = db.prepare(`SELECT * FROM atendentes WHERE id = ?`).get(req.params.id);
    if (!existente) return res.status(404).json({ erro: 'Atendente não encontrado.' });

    const campos = {};
    if (req.body.nome !== undefined) campos.nome = req.body.nome.trim();
    if (req.body.departamentoId !== undefined) campos.departamento_id = req.body.departamentoId || null;
    if (req.body.ativo !== undefined) campos.ativo = req.body.ativo ? 1 : 0;
    if (req.body.papel !== undefined) {
      if (!PAPEIS_VALIDOS.includes(req.body.papel)) {
        return res.status(400).json({ erro: `Papel inválido. Use um de: ${PAPEIS_VALIDOS.join(', ')}.` });
      }
      campos.papel = req.body.papel;
    }
    if (req.body.adminTotal !== undefined) campos.admin_total = req.body.adminTotal ? 1 : 0;
    const colunas = Object.keys(campos);
    if (colunas.length) {
      db.prepare(`UPDATE atendentes SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...colunas.map((c) => campos[c]), req.params.id);
    }
    res.json(db.prepare(`SELECT * FROM atendentes WHERE id = ?`).get(req.params.id));
  });

  // Define a lista COMPLETA de departamentos liderados por alguém (substitui
  // tudo — mais simples que endpoint incremental de add/remove um por um).
  // Só faz sentido pra quem é papel='lider', mas não bloqueia se for
  // chamado pra outro papel (fica só sem efeito, já que
  // departamentosVisiveisPor só lê essa tabela pra líder).
  router.put('/atendentes/:id/departamentos-liderados', exigirPapel('gestor'), (req, res) => {
    const existente = db.prepare(`SELECT * FROM atendentes WHERE id = ?`).get(req.params.id);
    if (!existente) return res.status(404).json({ erro: 'Atendente não encontrado.' });
    const departamentoIds = Array.isArray(req.body.departamentoIds) ? req.body.departamentoIds : [];

    db.prepare(`DELETE FROM atendente_departamentos_liderados WHERE atendente_id = ?`).run(req.params.id);
    const inserir = db.prepare(`INSERT INTO atendente_departamentos_liderados (atendente_id, departamento_id) VALUES (?, ?)`);
    for (const depId of departamentoIds) inserir.run(req.params.id, depId);

    res.json({ atendenteId: Number(req.params.id), departamentoIds });
  });

  router.get('/atendentes/:id/departamentos-liderados', (req, res) => {
    const linhas = db.prepare(`SELECT departamento_id FROM atendente_departamentos_liderados WHERE atendente_id = ?`).all(req.params.id);
    res.json(linhas.map((r) => r.departamento_id));
  });

  // --- Solicitantes --------------------------------------------------------
  router.get('/solicitantes', (req, res) => {
    const linhas = db.prepare(`SELECT * FROM solicitantes ORDER BY nome`).all();
    res.json(linhas);
  });

  // Cria o solicitante se o email ainda não existir, ou devolve o que já
  // existe — pensado pra ser chamado a partir do formulário de abertura de
  // chamado sem o usuário precisar "se cadastrar" antes.
  router.post('/solicitantes', (req, res) => {
    const { nome, email } = req.body;
    if (!nome || !nome.trim() || !email || !email.trim()) {
      return res.status(400).json({ erro: 'Informe nome e email.' });
    }
    const emailNormalizado = email.trim().toLowerCase();
    const existente = db.prepare(`SELECT * FROM solicitantes WHERE email = ?`).get(emailNormalizado);
    if (existente) return res.status(200).json(existente);

    const info = db
      .prepare(`INSERT INTO solicitantes (nome, email) VALUES (?, ?)`)
      .run(nome.trim(), emailNormalizado);
    const criado = db.prepare(`SELECT * FROM solicitantes WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json(criado);
  });

  // --- Políticas de SLA ------------------------------------------------------
  router.get('/sla-politicas', (req, res) => {
    const linhas = db.prepare(`SELECT * FROM sla_politicas ORDER BY departamento_id, categoria_id, prioridade`).all();
    res.json(linhas);
  });

  router.post('/sla-politicas', exigirPapel('gestor'), (req, res) => {
    const {
      departamentoId,
      categoriaId, // opcional: null = política do departamento inteiro
      prioridade,
      prazoPrimeiraRespostaMinutos,
      prazoResolucaoMinutos,
    } = req.body;
    if (!departamentoId || !prioridade || !prazoPrimeiraRespostaMinutos || !prazoResolucaoMinutos) {
      return res.status(400).json({
        erro: 'Informe departamentoId, prioridade, prazoPrimeiraRespostaMinutos e prazoResolucaoMinutos.',
      });
    }
    try {
      const info = db
        .prepare(
          `INSERT INTO sla_politicas
             (departamento_id, categoria_id, prioridade, prazo_primeira_resposta_minutos, prazo_resolucao_minutos)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(departamentoId, categoriaId || null, prioridade, prazoPrimeiraRespostaMinutos, prazoResolucaoMinutos);
      const criado = db.prepare(`SELECT * FROM sla_politicas WHERE id = ?`).get(info.lastInsertRowid);
      res.status(201).json(criado);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ erro: 'Já existe uma política de SLA pra essa combinação de departamento/categoria/prioridade.' });
      }
      throw e;
    }
  });

  return router;
}

module.exports = { referenciaRouter };
