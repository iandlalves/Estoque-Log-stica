// Usuários & Hosts (aba "Colaboradores" na UI, ver public/app.js) —
// consulta o Active Directory DIRETO via LDAP (2026-09-18). Antes lia um
// Mapeamento-AD-Dados.json gerado por uma máquina Windows separada, mas
// isso deixava o servidor Linux dependente daquele PC específico estar de
// pé e exportando o arquivo — trocado por consulta direta ao AD (ver
// src/lib/ldap.js), que depende só do controlador de domínio, já
// infraestrutura central.
//
// Continua só leitura, de propósito: a conta de bind LDAP é só-consulta,
// nunca escreve nada de volta no AD. Quem grava host/service tag/IP/SO/
// último login nos atributos customizados continua sendo o projeto de
// mapeamento de AD (GPO + script de logon), só a LEITURA mudou de lugar.

const express = require('express');
const { buscarUsuariosAD, ldapConfigurado, motivoNaoConfigurado } = require('../lib/ldap');

function adRouter() {
  const router = express.Router();

  router.get('/ad/usuarios', async (req, res) => {
    if (!ldapConfigurado()) {
      return res.status(501).json({
        erro: `${motivoNaoConfigurado()} Ver README, seção "Colaboradores — dados do AD".`,
      });
    }
    try {
      const dados = await buscarUsuariosAD();
      res.json(dados);
    } catch (e) {
      res.status(502).json({ erro: e.message });
    }
  });

  return router;
}

module.exports = { adRouter };
