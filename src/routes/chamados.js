// Motor de chamados — endpoints principais da plataforma.
//
// Nesta primeira fase (só equipe de Infra usando), todo mundo que acessa a
// API é considerado "atendente" — não existe ainda uma tela pública pro
// solicitante abrir o próprio chamado (isso é cotado pra quando a
// plataforma for liberada pra empresa inteira). Por enquanto o próprio
// atendente registra o chamado em nome do solicitante.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { calcularPrazos } = require('../lib/sla');
const { gerarProtocolo } = require('../lib/protocolo');
const { exigirPapel, departamentosVisiveisPor } = require('../lib/auth');

const STATUS_VALIDOS = ['aberto', 'em_atendimento', 'aguardando_cliente', 'finalizado', 'cancelado'];
const STATUS_TERMINAIS = ['finalizado', 'cancelado'];
const PRIORIDADES_VALIDAS = ['baixa', 'normal', 'alta', 'urgente'];

// 5 níveis nomeados (2026-09-03) — substituiu a estrela 1-5. Mapa pra
// preencher a coluna legada "nota" (ver comentário em prisma/schema.sql).
const SATISFACAO_VALIDAS = ['muito_satisfeito', 'satisfeito', 'regular', 'insatisfeito', 'muito_insatisfeito'];
const SATISFACAO_PARA_NOTA = {
  muito_satisfeito: 5,
  satisfeito: 4,
  regular: 3,
  insatisfeito: 2,
  muito_insatisfeito: 1,
};
const SATISFACOES_INSATISFEITAS = ['insatisfeito', 'muito_insatisfeito'];

// Anexos de chamado/comentário (2026-09-03) — mesmo padrão exato de upload
// já usado em src/routes/cpd.js e src/routes/estoque.js: diskStorage, nome
// salvo em disco sempre gerado (nunca file.originalname), tipo aceito por
// whitelist de mimetype.
const PASTA_ANEXOS = path.join(__dirname, '..', '..', 'dados', 'chamados-anexos');
fs.mkdirSync(PASTA_ANEXOS, { recursive: true });

const TIPOS_ANEXO_CHAMADO = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/zip': '.zip',
};
const uploadAnexos = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PASTA_ANEXOS),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${TIPOS_ANEXO_CHAMADO[file.mimetype] || ''}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 }, // 20MB por arquivo, até 5 por envio
  fileFilter: (req, file, cb) => {
    if (!TIPOS_ANEXO_CHAMADO[file.mimetype]) {
      return cb(new Error('Formato de anexo não suportado.'));
    }
    cb(null, true);
  },
});

// Aplica o multer só quando o corpo é multipart (quando há anexo) — uma
// requisição JSON pura (sem anexo, compatibilidade com o front antigo)
// passa direto sem o multer entrar no meio. Erro de validação do multer
// (tipo não suportado, arquivo grande demais) vira 400 já formatado, em
// vez do handler de erro genérico do server.js.
function comAnexos(campo) {
  const middleware = uploadAnexos.array(campo, 5);
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ erro: 'Anexo muito grande (máximo 20MB por arquivo).' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ erro: 'No máximo 5 anexos por envio.' });
      res.status(400).json({ erro: err.message });
    });
  };
}

// Some com os arquivos já salvos em disco quando a validação do resto do
// corpo falha depois do multer já ter gravado — mesmo padrão de limpeza de
// cpd.js/estoque.js, pra não deixar lixo órfão em dados/chamados-anexos/.
function limparAnexosOrfaos(req) {
  for (const file of req.files || []) fs.unlink(file.path, () => {});
}

function agoraIso() {
  return new Date().toISOString();
}

// SLA "estourado" só faz sentido pra chamado ainda não finalizado — depois
// de finalizar, o que importa é sla_*_cumprida (calculado uma vez, na hora
// da mudança de status), não o relógio correndo. Cálculo em JS (não SQL),
// mesmo estilo já usado em src/lib/estoqueResumo.js.
function calcularFlagsSla(chamado) {
  const agora = agoraIso();
  const terminal = STATUS_TERMINAIS.includes(chamado.status);
  return {
    slaPrimeiraRespostaEstourada:
      !terminal && !chamado.primeira_resposta_em && !!chamado.sla_prazo_primeira_resposta && agora > chamado.sla_prazo_primeira_resposta,
    slaResolucaoEstourada: !terminal && !!chamado.sla_prazo_resolucao && agora > chamado.sla_prazo_resolucao,
  };
}

// Pendência de avaliação (2026-09-03): chamado finalizado sem uma avaliação
// "válida pro ciclo atual" — ver comentário grande em prisma/schema.sql
// sobre por que isso é comparado por data em vez de existência da linha
// (upsert + possível reabertura/refinalização mudam o que conta como
// "atual"). Reaproveitada tanto no bloqueio de POST / quanto na flag do
// GET /.
function temAvaliacaoPendente(db, chamadoId) {
  const chamado = db.prepare(`SELECT status, finalizado_em FROM chamados WHERE id = ?`).get(chamadoId);
  if (!chamado || chamado.status !== 'finalizado') return false;
  const avaliacao = db.prepare(`SELECT criado_em FROM avaliacoes WHERE chamado_id = ?`).get(chamadoId);
  return !avaliacao || avaliacao.criado_em < chamado.finalizado_em;
}

// Todos os chamados finalizados do próprio Operador com avaliação pendente
// (ver temAvaliacaoPendente) — usado pra bloquear abertura de chamado novo.
function avaliacaoPendente(db, atendente) {
  const proprio = resolverSolicitanteProprio(db, atendente);
  const finalizados = db
    .prepare(`SELECT id, protocolo, finalizado_em FROM chamados WHERE solicitante_id = ? AND status = 'finalizado'`)
    .all(proprio.id);
  return finalizados.filter((c) => temAvaliacaoPendente(db, c.id));
}

// Reabre um chamado terminal — usado tanto pelo endpoint manual
// (PATCH /:id/reabrir) quanto pelo gatilho automático de avaliação
// insatisfeita. Não mexe em atendente_id (continua com quem já atendia).
// atendenteId omitido/undefined = gatilho automático (grava NULL no
// histórico, mesmo campo que já significa "automático/sistema").
function reabrirChamado(db, chamado, { atendenteId } = {}) {
  const agora = agoraIso();
  db.prepare(`UPDATE chamados SET status = 'aberto', finalizado_em = NULL WHERE id = ?`).run(chamado.id);
  db.prepare(
    `INSERT INTO chamado_historico_status (chamado_id, status_anterior, status_novo, atendente_id, criado_em)
     VALUES (?, ?, 'aberto', ?, ?)`
  ).run(chamado.id, chamado.status, atendenteId || null, agora);
}

function buscarChamadoCompleto(db, id) {
  const chamado = db
    .prepare(
      `SELECT
         c.*,
         d.nome AS departamento_nome,
         cat.nome AS categoria_nome,
         sub.nome AS subcategoria_nome,
         s.nome AS solicitante_nome, s.email AS solicitante_email,
         a.nome AS atendente_nome
       FROM chamados c
       JOIN departamentos d ON d.id = c.departamento_id
       JOIN categorias cat ON cat.id = c.categoria_id
       LEFT JOIN subcategorias sub ON sub.id = c.subcategoria_id
       JOIN solicitantes s ON s.id = c.solicitante_id
       LEFT JOIN atendentes a ON a.id = c.atendente_id
       WHERE c.id = ?`
    )
    .get(id);
  if (!chamado) return null;

  const historico = db
    .prepare(
      `SELECT h.*, a.nome AS atendente_nome
       FROM chamado_historico_status h
       LEFT JOIN atendentes a ON a.id = h.atendente_id
       WHERE h.chamado_id = ?
       ORDER BY h.criado_em ASC`
    )
    .all(id);

  // apagado_em IS NOT NULL = comentário removido pelo próprio autor (soft
  // delete) — some da resposta, mesmo espírito do ativo=0 de departamentos/
  // categorias.
  const comentarios = db
    .prepare(`SELECT * FROM comentarios WHERE chamado_id = ? AND apagado_em IS NULL ORDER BY criado_em ASC`)
    .all(id);

  const anexos = db
    .prepare(`SELECT * FROM chamado_anexos WHERE chamado_id = ? ORDER BY criado_em ASC`)
    .all(id);
  const anexosDoChamado = anexos.filter((a) => a.comentario_id === null);
  for (const c of comentarios) {
    c.anexos = anexos.filter((a) => a.comentario_id === c.id);
  }

  const avaliacao = db.prepare(`SELECT * FROM avaliacoes WHERE chamado_id = ?`).get(id) || null;

  return { ...chamado, ...calcularFlagsSla(chamado), historico, comentarios, anexos: anexosDoChamado, avaliacao };
}

// Regra de negócio de "criar chamado" isolada da rota HTTP — assim tanto
// POST /api/chamados (uso normal, pelo atendente logado) quanto a
// integração com Teams (src/routes/integracaoTeams.js, sem sessão de
// navegador, chave de API própria) usam exatamente a mesma lógica (mesmo
// find-or-create de solicitante, mesmo cálculo de protocolo/SLA), sem
// duplicar nada. Lança um Error com `.status` (código HTTP) quando a
// entrada é inválida — quem chama decide como devolver isso pro cliente.
function criarChamado(db, dados) {
  const { assunto, descricao, departamentoId, categoriaId, prioridade = 'normal' } = dados;
  let { solicitanteId, solicitante, subcategoriaId } = dados; // solicitante = { nome, email } opcional, pra criar na hora

  const erro = (status, mensagem) => Object.assign(new Error(mensagem), { status });

  if (!assunto || !assunto.trim() || !descricao || !descricao.trim()) {
    throw erro(400, 'Informe assunto e descrição.');
  }
  if (!departamentoId || !categoriaId) {
    throw erro(400, 'Informe departamentoId e categoriaId.');
  }
  if (!PRIORIDADES_VALIDAS.includes(prioridade)) {
    throw erro(400, `Prioridade inválida. Use uma de: ${PRIORIDADES_VALIDAS.join(', ')}.`);
  }

  const dep = db.prepare(`SELECT * FROM departamentos WHERE id = ?`).get(departamentoId);
  if (!dep) throw erro(400, 'Departamento não encontrado.');
  const cat = db.prepare(`SELECT * FROM categorias WHERE id = ? AND departamento_id = ?`).get(categoriaId, departamentoId);
  if (!cat) throw erro(400, 'Categoria não encontrada nesse departamento.');

  // Subcategoria (2026-09-03): só obrigatória quando a categoria já tem
  // alguma cadastrada — categoria ainda não detalhada não trava ninguém.
  const subcategoriasDaCategoria = db
    .prepare(`SELECT * FROM subcategorias WHERE categoria_id = ? AND ativo = 1`)
    .all(categoriaId);
  if (subcategoriasDaCategoria.length) {
    if (!subcategoriaId) throw erro(400, 'Informe subcategoriaId — essa categoria tem subcategorias cadastradas.');
    if (!subcategoriasDaCategoria.some((s) => s.id === Number(subcategoriaId))) {
      throw erro(400, 'Subcategoria não encontrada nessa categoria.');
    }
  } else {
    subcategoriaId = null;
  }

  if (!solicitanteId) {
    if (!solicitante || !solicitante.nome || !solicitante.email) {
      throw erro(400, 'Informe solicitanteId, ou solicitante { nome, email }.');
    }
    const email = solicitante.email.trim().toLowerCase();
    const existente = db.prepare(`SELECT * FROM solicitantes WHERE email = ?`).get(email);
    if (existente) {
      solicitanteId = existente.id;
    } else {
      const info = db.prepare(`INSERT INTO solicitantes (nome, email) VALUES (?, ?)`).run(solicitante.nome.trim(), email);
      solicitanteId = info.lastInsertRowid;
    }
  }

  const criadoEm = agoraIso();
  const protocolo = gerarProtocolo(db, new Date(criadoEm));
  const { slaPrazoPrimeiraResposta, slaPrazoResolucao } = calcularPrazos(db, {
    departamentoId,
    categoriaId,
    prioridade,
    criadoEm,
  });

  const info = db
    .prepare(
      `INSERT INTO chamados
         (protocolo, assunto, descricao, prioridade, status, departamento_id, categoria_id, subcategoria_id, solicitante_id,
          criado_em, sla_prazo_primeira_resposta, sla_prazo_resolucao)
       VALUES (?, ?, ?, ?, 'aberto', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      protocolo,
      assunto.trim(),
      descricao.trim(),
      prioridade,
      departamentoId,
      categoriaId,
      subcategoriaId || null,
      solicitanteId,
      criadoEm,
      slaPrazoPrimeiraResposta,
      slaPrazoResolucao
    );

  db.prepare(
    `INSERT INTO chamado_historico_status (chamado_id, status_anterior, status_novo, criado_em)
     VALUES (?, NULL, 'aberto', ?)`
  ).run(info.lastInsertRowid, criadoEm);

  return buscarChamadoCompleto(db, info.lastInsertRowid);
}

// Acha o solicitante correspondente à própria conta de um Operador (mesmo
// find-or-create por email que criarChamado já faz pra solicitante
// qualquer) — usado pra forçar "só posso abrir/ver chamado em meu próprio
// nome" em vários pontos abaixo, sem duplicar a lógica.
function resolverSolicitanteProprio(db, atendente) {
  const email = atendente.email.trim().toLowerCase();
  const existente = db.prepare(`SELECT * FROM solicitantes WHERE email = ?`).get(email);
  if (existente) return existente;
  const info = db.prepare(`INSERT INTO solicitantes (nome, email) VALUES (?, ?)`).run(atendente.nome, email);
  return db.prepare(`SELECT * FROM solicitantes WHERE id = ?`).get(info.lastInsertRowid);
}

// Escopo de visibilidade por papel (ver src/lib/auth.js): Operador só o que
// ELE abriu; Atendente/Líder só o(s) departamento(s) visíveis; Gestor tudo.
function temAcessoChamado(db, atendente, chamado) {
  if (atendente.papel === 'operador') {
    return chamado.solicitante_id === resolverSolicitanteProprio(db, atendente).id;
  }
  const deps = departamentosVisiveisPor(db, atendente);
  return deps === null || deps.includes(chamado.departamento_id);
}

function chamadosRouter(db) {
  const router = express.Router();

  // --- Criar chamado -------------------------------------------------------
  // comAnexos só entra em ação quando o corpo é multipart (há anexo) —
  // requisição JSON pura passa direto, sem mudança de comportamento.
  router.post('/', comAnexos('anexos'), (req, res) => {
    try {
      const dados = { ...req.body };
      // FormData "achata" objeto aninhado — se o front mandou
      // solicitanteNome/solicitanteEmail em vez de solicitante{nome,email}
      // (caso de multipart), remonta antes de chamar criarChamado.
      if (!dados.solicitante && dados.solicitanteNome && dados.solicitanteEmail) {
        dados.solicitante = { nome: dados.solicitanteNome, email: dados.solicitanteEmail };
      }
      // Operador não pode abrir chamado "em nome de" ninguém — força ser
      // ele mesmo, ignorando qualquer solicitanteId/solicitante do corpo.
      if (req.atendente.papel === 'operador') {
        dados.solicitanteId = undefined;
        dados.solicitante = { nome: req.atendente.nome, email: req.atendente.email };

        // Bloqueio (2026-09-03): Operador com chamado finalizado sem
        // avaliar não pode abrir chamado novo até resolver isso.
        const pendentes = avaliacaoPendente(db, req.atendente);
        if (pendentes.length) {
          limparAnexosOrfaos(req);
          return res.status(409).json({
            erro: `Avalie o(s) chamado(s) finalizado(s) pendente(s) antes de abrir um novo: ${pendentes.map((c) => c.protocolo).join(', ')}.`,
            protocolosPendentes: pendentes.map((c) => c.protocolo),
          });
        }
      }

      const criado = criarChamado(db, dados);

      for (const file of req.files || []) {
        db.prepare(
          `INSERT INTO chamado_anexos (chamado_id, atendente_id, nome_original, arquivo, tipo, tamanho)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(criado.id, req.atendente.id, file.originalname, file.filename, file.mimetype, file.size);
      }

      res.status(201).json(req.files && req.files.length ? buscarChamadoCompleto(db, criado.id) : criado);
    } catch (e) {
      limparAnexosOrfaos(req);
      res.status(e.status || 500).json({ erro: e.message });
    }
  });

  // --- Listar / filtrar --------------------------------------------------
  router.get('/', (req, res) => {
    const { status, categoriaId, atendenteId, de, ate, busca } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 200);

    const condicoes = [];
    const params = [];

    // Filtro OBRIGATÓRIO por papel — vem antes de qualquer filtro opcional
    // de query, e não é sobrescrevível por ele (Operador nunca vê chamado
    // de outra pessoa, Atendente/Líder nunca veem outro departamento,
    // mesmo que tentem passar departamentoId/solicitanteId na query).
    if (req.atendente.papel === 'operador') {
      const proprio = resolverSolicitanteProprio(db, req.atendente);
      condicoes.push('c.solicitante_id = ?');
      params.push(proprio.id);
    } else {
      const deps = departamentosVisiveisPor(db, req.atendente);
      if (deps !== null) {
        if (!deps.length) return res.json({ total: 0, page, pageSize, chamados: [] });
        condicoes.push(`c.departamento_id IN (${deps.map(() => '?').join(',')})`);
        params.push(...deps);
      }
      // departamentoId da query só faz sentido pra quem não é Operador —
      // Gestor filtra livre; Atendente/Líder já vem restrito acima, isso só
      // estreita ainda mais dentro do que já pode ver.
      if (req.query.departamentoId) { condicoes.push('c.departamento_id = ?'); params.push(req.query.departamentoId); }
    }

    if (status) { condicoes.push('c.status = ?'); params.push(status); }
    if (categoriaId) { condicoes.push('c.categoria_id = ?'); params.push(categoriaId); }
    if (atendenteId) { condicoes.push('c.atendente_id = ?'); params.push(atendenteId); }
    if (de) { condicoes.push('c.criado_em >= ?'); params.push(de); }
    if (ate) { condicoes.push('c.criado_em <= ?'); params.push(ate); }
    if (busca) {
      condicoes.push('(c.protocolo LIKE ? OR c.assunto LIKE ? OR c.descricao LIKE ?)');
      const termo = `%${busca}%`;
      params.push(termo, termo, termo);
    }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS total FROM chamados c ${where}`).get(...params).total;

    const linhas = db
      .prepare(
        `SELECT
           c.id, c.protocolo, c.assunto, c.prioridade, c.status,
           c.criado_em, c.primeira_resposta_em, c.finalizado_em,
           c.sla_prazo_primeira_resposta, c.sla_prazo_resolucao,
           c.sla_primeira_resposta_cumprida, c.sla_resolucao_cumprida,
           d.nome AS departamento_nome, cat.nome AS categoria_nome,
           s.nome AS solicitante_nome, a.nome AS atendente_nome
         FROM chamados c
         JOIN departamentos d ON d.id = c.departamento_id
         JOIN categorias cat ON cat.id = c.categoria_id
         JOIN solicitantes s ON s.id = c.solicitante_id
         LEFT JOIN atendentes a ON a.id = c.atendente_id
         ${where}
         ORDER BY c.criado_em DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize);

    // Flags calculadas em JS (não SQL), mesmo estilo de estoqueResumo.js —
    // indicador visual de SLA na lista, e "precisa avaliar" só pro Operador
    // (evita uma query extra por linha pra quem não é Operador).
    const chamados = linhas.map((c) => ({
      ...c,
      ...calcularFlagsSla(c),
      ...(req.atendente.papel === 'operador' ? { avaliacaoPendente: temAvaliacaoPendente(db, c.id) } : {}),
    }));

    res.json({ total, page, pageSize, chamados });
  });

  // --- Ver um chamado (com histórico, comentários, avaliação) ------------
  router.get('/:id', (req, res) => {
    const chamado = buscarChamadoCompleto(db, req.params.id);
    if (!chamado || !temAcessoChamado(db, req.atendente, chamado)) {
      return res.status(404).json({ erro: 'Chamado não encontrado.' });
    }
    // Operador não vê nota interna da equipe (comentario.interno=1).
    if (req.atendente.papel === 'operador') {
      chamado.comentarios = chamado.comentarios.filter((c) => !c.interno);
    }
    res.json(chamado);
  });

  // --- Download de anexo (2026-09-03) --------------------------------------
  // Diferente das rotas de download de CPD/Estoque (que não checam escopo
  // porque não precisam), aqui o chamado tem visibilidade restrita por
  // papel/departamento/solicitante — replica a mesma checagem de GET /:id.
  router.get('/:id/anexos/:anexoId', (req, res) => {
    const chamado = db.prepare(`SELECT * FROM chamados WHERE id = ?`).get(req.params.id);
    if (!chamado || !temAcessoChamado(db, req.atendente, chamado)) {
      return res.status(404).json({ erro: 'Chamado não encontrado.' });
    }
    const anexo = db.prepare(`SELECT * FROM chamado_anexos WHERE id = ? AND chamado_id = ?`).get(req.params.anexoId, req.params.id);
    if (!anexo) return res.status(404).json({ erro: 'Anexo não encontrado.' });
    const caminho = path.join(PASTA_ANEXOS, anexo.arquivo);
    if (!fs.existsSync(caminho)) return res.status(404).json({ erro: 'Anexo não encontrado no servidor.' });
    res.download(caminho, anexo.nome_original);
  });

  // --- Atribuir atendente --------------------------------------------------
  router.patch('/:id/atribuir', exigirPapel('atendente', 'lider', 'gestor'), (req, res) => {
    const { atendenteId } = req.body;
    const chamado = db.prepare(`SELECT * FROM chamados WHERE id = ?`).get(req.params.id);
    if (!chamado || !temAcessoChamado(db, req.atendente, chamado)) {
      return res.status(404).json({ erro: 'Chamado não encontrado.' });
    }
    if (atendenteId) {
      const atendente = db.prepare(`SELECT * FROM atendentes WHERE id = ?`).get(atendenteId);
      if (!atendente) return res.status(400).json({ erro: 'Atendente não encontrado.' });
    }
    db.prepare(`UPDATE chamados SET atendente_id = ? WHERE id = ?`).run(atendenteId || null, req.params.id);
    res.json(buscarChamadoCompleto(db, req.params.id));
  });

  // --- Mudar status (grava histórico e calcula os marcos de SLA) ---------
  router.patch('/:id/status', exigirPapel('atendente', 'lider', 'gestor'), (req, res) => {
    const { novoStatus } = req.body;
    const atendenteId = req.atendente.id; // sempre quem está logado, não o que vier do corpo
    if (!STATUS_VALIDOS.includes(novoStatus)) {
      return res.status(400).json({ erro: `Status inválido. Use um de: ${STATUS_VALIDOS.join(', ')}.` });
    }
    const chamado = db.prepare(`SELECT * FROM chamados WHERE id = ?`).get(req.params.id);
    if (!chamado || !temAcessoChamado(db, req.atendente, chamado)) {
      return res.status(404).json({ erro: 'Chamado não encontrado.' });
    }
    if (STATUS_TERMINAIS.includes(chamado.status)) {
      return res.status(409).json({ erro: `Chamado já está "${chamado.status}" — reabra criando um novo chamado em vez de mudar o status deste.` });
    }

    const agora = agoraIso();
    const campos = { status: novoStatus };

    // Primeira resposta: primeira vez que o chamado sai de "aberto".
    if (!chamado.primeira_resposta_em && novoStatus !== 'aberto') {
      campos.primeira_resposta_em = agora;
      campos.sla_primeira_resposta_cumprida = chamado.sla_prazo_primeira_resposta
        ? (agora <= chamado.sla_prazo_primeira_resposta ? 1 : 0)
        : null;
    }

    // Finalização: fecha o relógio de resolução. Cancelado não conta pro
    // cálculo de SLA (mesma regra que já valia lendo do TomTicket).
    if (STATUS_TERMINAIS.includes(novoStatus)) {
      campos.finalizado_em = agora;
      if (novoStatus === 'finalizado') {
        campos.sla_resolucao_cumprida = chamado.sla_prazo_resolucao
          ? (agora <= chamado.sla_prazo_resolucao ? 1 : 0)
          : null;
      } else {
        campos.sla_resolucao_cumprida = null;
      }
    }

    const sets = Object.keys(campos).map((k) => `${k} = ?`).join(', ');
    const valores = Object.values(campos);
    db.prepare(`UPDATE chamados SET ${sets} WHERE id = ?`).run(...valores, req.params.id);

    db.prepare(
      `INSERT INTO chamado_historico_status (chamado_id, status_anterior, status_novo, atendente_id, criado_em)
       VALUES (?, ?, ?, ?, ?)`
    ).run(req.params.id, chamado.status, novoStatus, atendenteId || null, agora);

    res.json(buscarChamadoCompleto(db, req.params.id));
  });

  // --- Reabrir chamado terminal (2026-09-03) ------------------------------
  router.patch('/:id/reabrir', exigirPapel('atendente', 'lider', 'gestor'), (req, res) => {
    const chamado = db.prepare(`SELECT * FROM chamados WHERE id = ?`).get(req.params.id);
    if (!chamado || !temAcessoChamado(db, req.atendente, chamado)) {
      return res.status(404).json({ erro: 'Chamado não encontrado.' });
    }
    if (!STATUS_TERMINAIS.includes(chamado.status)) {
      return res.status(409).json({ erro: 'Só é possível reabrir um chamado finalizado ou cancelado.' });
    }
    reabrirChamado(db, chamado, { atendenteId: req.atendente.id });
    res.json(buscarChamadoCompleto(db, req.params.id));
  });

  // --- Editar chamado de outra pessoa (2026-09-03, Líder/Gestor) ----------
  // Não inclui departamentoId de propósito — "transferir chamado entre
  // departamentos" é uma feature separada (Onda 2), pra não misturar as
  // duas coisas num só endpoint.
  router.patch('/:id/editar', exigirPapel('lider', 'gestor'), (req, res) => {
    const chamado = db.prepare(`SELECT * FROM chamados WHERE id = ?`).get(req.params.id);
    if (!chamado || !temAcessoChamado(db, req.atendente, chamado)) {
      return res.status(404).json({ erro: 'Chamado não encontrado.' });
    }

    const campos = {};
    if (req.body.assunto !== undefined) {
      if (!req.body.assunto.trim()) return res.status(400).json({ erro: 'Assunto não pode ficar vazio.' });
      campos.assunto = req.body.assunto.trim();
    }
    if (req.body.descricao !== undefined) {
      if (!req.body.descricao.trim()) return res.status(400).json({ erro: 'Descrição não pode ficar vazia.' });
      campos.descricao = req.body.descricao.trim();
    }
    if (req.body.prioridade !== undefined) {
      if (!PRIORIDADES_VALIDAS.includes(req.body.prioridade)) {
        return res.status(400).json({ erro: `Prioridade inválida. Use uma de: ${PRIORIDADES_VALIDAS.join(', ')}.` });
      }
      campos.prioridade = req.body.prioridade;
    }
    if (req.body.categoriaId !== undefined) {
      const cat = db.prepare(`SELECT * FROM categorias WHERE id = ? AND departamento_id = ?`).get(req.body.categoriaId, chamado.departamento_id);
      if (!cat) return res.status(400).json({ erro: 'Categoria não encontrada nesse departamento.' });
      campos.categoria_id = req.body.categoriaId;
    }
    if (req.body.subcategoriaId !== undefined) {
      const categoriaAlvo = campos.categoria_id || chamado.categoria_id;
      if (req.body.subcategoriaId === null) {
        campos.subcategoria_id = null;
      } else {
        const sub = db.prepare(`SELECT * FROM subcategorias WHERE id = ? AND categoria_id = ?`).get(req.body.subcategoriaId, categoriaAlvo);
        if (!sub) return res.status(400).json({ erro: 'Subcategoria não encontrada nessa categoria.' });
        campos.subcategoria_id = req.body.subcategoriaId;
      }
    }

    const colunas = Object.keys(campos);
    if (colunas.length) {
      db.prepare(`UPDATE chamados SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...colunas.map((c) => campos[c]), req.params.id);
    }
    res.json(buscarChamadoCompleto(db, req.params.id));
  });

  // --- Comentários -----------------------------------------------------
  router.post('/:id/comentarios', comAnexos('anexos'), (req, res) => {
    const { texto } = req.body;
    // Autor é sempre quem está logado — não dá mais pra um atendente
    // comentar "em nome de" outra pessoa preenchendo autorNome à mão.
    const { id: atendenteId, nome: autorNome } = req.atendente;
    // Operador nunca marca interno (é o próprio solicitante — "nota interna
    // da equipe" não existiria) mesmo que tente mandar isso no corpo.
    // req.body.interno pode chegar como string ('true'/'false') quando o
    // corpo é multipart (há anexo) em vez de JSON — trata os dois casos.
    const interno = req.atendente.papel === 'operador' ? false : (req.body.interno === true || req.body.interno === 'true');
    const chamado = db.prepare(`SELECT * FROM chamados WHERE id = ?`).get(req.params.id);
    if (!chamado || !temAcessoChamado(db, req.atendente, chamado)) {
      limparAnexosOrfaos(req);
      return res.status(404).json({ erro: 'Chamado não encontrado.' });
    }
    if (!texto || !texto.trim()) {
      limparAnexosOrfaos(req);
      return res.status(400).json({ erro: 'Informe o texto do comentário.' });
    }
    const info = db
      .prepare(
        `INSERT INTO comentarios (chamado_id, atendente_id, autor_nome, texto, interno)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(req.params.id, atendenteId, autorNome, texto.trim(), interno ? 1 : 0);

    for (const file of req.files || []) {
      db.prepare(
        `INSERT INTO chamado_anexos (chamado_id, comentario_id, atendente_id, nome_original, arquivo, tipo, tamanho)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(req.params.id, info.lastInsertRowid, atendenteId, file.originalname, file.filename, file.mimetype, file.size);
    }

    const criado = db.prepare(`SELECT * FROM comentarios WHERE id = ?`).get(info.lastInsertRowid);
    criado.anexos = db.prepare(`SELECT * FROM chamado_anexos WHERE comentario_id = ?`).all(info.lastInsertRowid);
    res.status(201).json(criado);
  });

  // --- Editar/apagar comentário próprio (2026-09-03) -----------------------
  // Só o autor, e só enquanto não estiver apagado — mesma checagem nos dois
  // endpoints.
  function comentarioProprioOuErro(req, res) {
    const chamado = db.prepare(`SELECT * FROM chamados WHERE id = ?`).get(req.params.id);
    if (!chamado || !temAcessoChamado(db, req.atendente, chamado)) {
      res.status(404).json({ erro: 'Chamado não encontrado.' });
      return null;
    }
    const comentario = db
      .prepare(`SELECT * FROM comentarios WHERE id = ? AND chamado_id = ? AND apagado_em IS NULL`)
      .get(req.params.comentarioId, req.params.id);
    if (!comentario) {
      res.status(404).json({ erro: 'Comentário não encontrado.' });
      return null;
    }
    if (comentario.atendente_id !== req.atendente.id) {
      res.status(403).json({ erro: 'Só é possível editar/apagar o próprio comentário.' });
      return null;
    }
    return comentario;
  }

  router.patch('/:id/comentarios/:comentarioId', (req, res) => {
    const comentario = comentarioProprioOuErro(req, res);
    if (!comentario) return;
    const { texto } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ erro: 'Informe o texto do comentário.' });
    db.prepare(`UPDATE comentarios SET texto = ?, editado_em = ? WHERE id = ?`).run(texto.trim(), agoraIso(), comentario.id);
    res.json(db.prepare(`SELECT * FROM comentarios WHERE id = ?`).get(comentario.id));
  });

  router.delete('/:id/comentarios/:comentarioId', (req, res) => {
    const comentario = comentarioProprioOuErro(req, res);
    if (!comentario) return;
    db.prepare(`UPDATE comentarios SET apagado_em = ? WHERE id = ?`).run(agoraIso(), comentario.id);
    res.json({ ok: true });
  });

  // --- Avaliação de satisfação (2026-09-03) --------------------------------
  // Só o próprio Operador/solicitante avalia o próprio chamado — removida a
  // flexibilidade anterior de um atendente registrar em nome de alguém.
  // "Insatisfeito"/"Muito insatisfeito" reabre o chamado automaticamente.
  router.post('/:id/avaliacao', exigirPapel('operador'), (req, res) => {
    const { satisfacao, comentario } = req.body;
    const chamado = db.prepare(`SELECT * FROM chamados WHERE id = ?`).get(req.params.id);
    if (!chamado || !temAcessoChamado(db, req.atendente, chamado)) {
      return res.status(404).json({ erro: 'Chamado não encontrado.' });
    }
    if (chamado.status !== 'finalizado') {
      return res.status(409).json({ erro: 'Só é possível avaliar um chamado finalizado.' });
    }
    if (!SATISFACAO_VALIDAS.includes(satisfacao)) {
      return res.status(400).json({ erro: `Satisfação inválida. Use uma de: ${SATISFACAO_VALIDAS.join(', ')}.` });
    }

    const agora = agoraIso();
    db.prepare(
      `INSERT INTO avaliacoes (chamado_id, nota, satisfacao, comentario, criado_em)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chamado_id) DO UPDATE SET nota = excluded.nota, satisfacao = excluded.satisfacao, comentario = excluded.comentario, criado_em = excluded.criado_em`
    ).run(req.params.id, SATISFACAO_PARA_NOTA[satisfacao], satisfacao, comentario ? comentario.trim() : null, agora);

    if (SATISFACOES_INSATISFEITAS.includes(satisfacao)) {
      reabrirChamado(db, chamado, {}); // gatilho automático — sem atendenteId, mesmo atendente_id do chamado continua
    }

    res.status(201).json(buscarChamadoCompleto(db, req.params.id));
  });

  return router;
}

module.exports = { chamadosRouter, criarChamado, STATUS_VALIDOS, PRIORIDADES_VALIDAS };
