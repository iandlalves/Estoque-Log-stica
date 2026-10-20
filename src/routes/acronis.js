// Aba "Segurança" (2026-09-30) — alertas do Acronis Cyber Protect. Ver
// src/lib/acronis.js pro detalhe de cada chamada e o que é confiável vs
// best-effort (pendente validação com credencial real).

const express = require('express');
const { sincronizarAlertas } = require('../lib/acronis');

function acronisRouter(db) {
  const router = express.Router();

  router.get('/acronis/alertas', (req, res) => {
    const resolvidos = req.query.resolvidos === '1';
    const linhas = db.prepare(
      resolvidos
        ? `SELECT * FROM acronis_alertas WHERE resolvido_em IS NOT NULL ORDER BY criado_em_acronis DESC`
        : `SELECT * FROM acronis_alertas WHERE resolvido_em IS NULL ORDER BY criado_em_acronis DESC`
    ).all();
    res.json(linhas);
  });

  router.post('/acronis/sincronizar', async (req, res) => {
    try {
      const resultado = await sincronizarAlertas(db);
      res.json(resultado);
    } catch (e) {
      res.status(502).json({ erro: e.message });
    }
  });

  router.get('/acronis/arquivos', (req, res) => {
    res.json(
      db.prepare(
        `SELECT m.id, m.mes, m.total_alertas, m.gerado_em, a.nome AS atendente_nome
         FROM acronis_arquivos_mensais m JOIN atendentes a ON a.id = m.atendente_id
         ORDER BY m.mes DESC, m.gerado_em DESC`
      ).all()
    );
  });

  router.get('/acronis/arquivos/:id', (req, res) => {
    const arquivo = db.prepare(
      `SELECT m.*, a.nome AS atendente_nome FROM acronis_arquivos_mensais m JOIN atendentes a ON a.id = m.atendente_id WHERE m.id = ?`
    ).get(req.params.id);
    if (!arquivo) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
    res.json({ ...arquivo, alertas: JSON.parse(arquivo.alertas_snapshot) });
  });

  // Não exige papel especial — mesmo grupo atendente/líder/gestor do resto
  // da plataforma (o gate já está no mount em src/server.js); arquivar o
  // mês é uma ação de rotina, não uma correção de histórico supervisionada.
  router.post('/acronis/arquivos', (req, res) => {
    const ativos = db.prepare(`SELECT * FROM acronis_alertas WHERE resolvido_em IS NULL ORDER BY criado_em_acronis DESC`).all();
    const mes = new Date().toISOString().slice(0, 7);
    const info = db.prepare(
      `INSERT INTO acronis_arquivos_mensais (mes, atendente_id, total_alertas, alertas_snapshot) VALUES (?, ?, ?, ?)`
    ).run(mes, req.atendente.id, ativos.length, JSON.stringify(ativos));
    res.status(201).json(db.prepare(`SELECT * FROM acronis_arquivos_mensais WHERE id = ?`).get(info.lastInsertRowid));
  });

  return router;
}

module.exports = { acronisRouter };
