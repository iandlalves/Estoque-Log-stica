// Aba "Atualizações" (2026-09-23) — inventário de firmware/driver dos
// servidores do CPD, checado automaticamente por uma de duas fontes (ver
// verificarServidorQualquerFonte): iDRAC (src/lib/idrac.js) pros
// servidores físicos Dell com controladora própria, ou SSH + Dell
// Command Update (src/lib/dellCommandUpdate.js, 2026-10-02) pros que não
// têm iDRAC. Reaproveita o catálogo cpd_servidores (mesma lista já usada
// no Checklist do CPD) em vez de duplicar cadastro — o que muda aqui são
// os campos idrac_host/dcu_host, editáveis pela tela Servidores/
// Receptoras (ver catalogoRouter em src/routes/cpd.js). Um servidor só
// tem UM dos dois preenchido, nunca os dois.

const express = require('express');
const { verificarServidor: verificarServidorIdrac } = require('../lib/idrac');
const { verificarServidor: verificarServidorDcu } = require('../lib/dellCommandUpdate');

function verificarServidorQualquerFonte(db, servidor) {
  if (servidor.idrac_host) return verificarServidorIdrac(db, servidor);
  if (servidor.dcu_host) return verificarServidorDcu(db, servidor);
  return Promise.reject(new Error('Esse servidor não tem iDRAC nem host de SSH cadastrado.'));
}

// IDs de servidor com checagem em andamento neste processo — em memória
// de propósito (reinicia com o processo; não precisa sobreviver a um
// restart, é só pro front saber que não deve disparar de novo enquanto
// espera). Compartilhado entre a checagem individual e a checagem "de
// todos" abaixo.
const emVerificacao = new Set();

// Quantas checagens rodar ao mesmo tempo na checagem "de todos" — limite
// pra não sobrecarregar as iDRACs/SSH nem a própria aplicação (cada
// checagem já é uma sequência de chamadas que demora sozinha).
const CONCORRENCIA_VERIFICACAO_TODOS = 3;

function firmwareRouter(db) {
  const router = express.Router();

  router.get('/firmware', (req, res) => {
    const servidores = db.prepare(`SELECT * FROM cpd_servidores WHERE ativo = 1 ORDER BY nome COLLATE NOCASE`).all();
    const itensPorServidor = new Map();
    for (const item of db.prepare(`SELECT * FROM cpd_firmware_itens ORDER BY componente COLLATE NOCASE`).all()) {
      if (!itensPorServidor.has(item.servidor_id)) itensPorServidor.set(item.servidor_id, []);
      itensPorServidor.get(item.servidor_id).push(item);
    }
    res.json(
      servidores.map((s) => ({
        ...s,
        itens: itensPorServidor.get(s.id) || [],
        verificando: emVerificacao.has(s.id),
      }))
    );
  });

  router.post('/firmware/:servidorId/verificar', async (req, res) => {
    const servidor = db.prepare(`SELECT * FROM cpd_servidores WHERE id = ? AND ativo = 1`).get(req.params.servidorId);
    if (!servidor) return res.status(404).json({ erro: 'Servidor não encontrado.' });
    if (!servidor.idrac_host && !servidor.dcu_host) {
      return res.status(400).json({ erro: 'Esse servidor ainda não tem IP da iDRAC nem host de SSH cadastrado (tela Servidores/Receptoras).' });
    }
    if (emVerificacao.has(servidor.id)) return res.status(409).json({ erro: 'Já tem uma checagem em andamento pra esse servidor.' });

    emVerificacao.add(servidor.id);
    try {
      const resultado = await verificarServidorQualquerFonte(db, servidor);
      res.json(resultado);
    } catch (e) {
      res.status(502).json({ erro: e.message });
    } finally {
      emVerificacao.delete(servidor.id);
    }
  });

  router.post('/firmware/verificar', (req, res) => {
    const todosAtivos = db.prepare(`SELECT * FROM cpd_servidores WHERE ativo = 1`).all();
    const comFonte = todosAtivos.filter((s) => (s.idrac_host && s.idrac_host.trim()) || (s.dcu_host && s.dcu_host.trim()));
    const pendentes = comFonte.filter((s) => !emVerificacao.has(s.id));
    const semIdrac = todosAtivos.length - comFonte.length;

    // Roda em background com concorrência limitada — a resposta HTTP não
    // espera terminar (várias checagens × comparação com catálogo pode
    // levar minutos no total); o front acompanha via polling em
    // GET /firmware (campo "verificando" + idrac_ultima_checagem mudando).
    (async () => {
      let indice = 0;
      async function trabalhador() {
        while (indice < pendentes.length) {
          const servidor = pendentes[indice++];
          emVerificacao.add(servidor.id);
          try {
            await verificarServidorQualquerFonte(db, servidor);
          } catch (e) {
            // já registrado em idrac_ultimo_erro por quem verificou
          } finally {
            emVerificacao.delete(servidor.id);
          }
        }
      }
      await Promise.all(Array.from({ length: CONCORRENCIA_VERIFICACAO_TODOS }, trabalhador));
    })();

    res.json({ iniciado: true, total: pendentes.length, semIdrac });
  });

  return router;
}

module.exports = { firmwareRouter };
