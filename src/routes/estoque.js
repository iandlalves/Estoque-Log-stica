// Estoque — migrado da ferramenta antiga (Central-de-Infraestrutura.html /
// Controle-de-Estoque.html), que guardava tudo num arquivo .json local via
// File System Access API. Aqui os mesmos 7 "blocos" de dados viram 7
// tabelas no banco (ver prisma/schema.sql), com API de verdade em vez de
// escrever direto num arquivo. Ver scripts/importar-estoque.js pra trazer
// os dados que já existiam na ferramenta antiga pra cá.
//
// O cálculo de saldo/status do catálogo principal (estoque_itens) replica
// de propósito a mesma lógica que a ferramenta antiga usava
// (computeStock/statusFor no Central-de-Infraestrutura.html): saldo =
// soma(ENTRADA) - soma(SAIDA) por nome de item (comparado sem
// acento/maiúscula), status = "COMPRAR" se saldo < mínimo, senão "OK" — a
// menos que exista um status manual definido. "DEVOLUÇÃO" é registrada no
// histórico mas não entra nessa conta, igual no original.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { normKey, calcularItensComSaldo, calcularResumoEstoque, formatarResumoEmail } = require('../lib/estoqueResumo');
const { calcularEquipamentosPorUsuario } = require('../lib/estoqueUsuarios');
const { anexarTermosAosItens } = require('../lib/estoqueTermosEquipamento');
const { padronizarEquipamento, padronizarModelo, padronizarServiceTag } = require('../lib/padronizacaoEquipamentos');
const { encontrarPossiveisDuplicados, unificarColaboradores } = require('../lib/unificarColaboradores');
const { statusOcr, lerArquivo, correspondenciasComEquipamentos, sugerirColaboradores } = require('../lib/ocrTermo');
const { gerarArquivoTermoDevolucao, PASTA_TERMOS } = require('../lib/termoPdf');
const { gerarTermoParaColaborador } = require('../lib/estoqueColaboradores');
const { enviarEmail } = require('../lib/email');
const { exigirPapel } = require('../lib/auth');

// Regra de permissão deste arquivo inteiro (2026-09-17): o dia a dia
// (registrar movimentação, gerar termo, cadastrar colaborador etc.) é
// livre pra quem atende (Atendente/Líder/Gestor — Operador já nem chega
// aqui, ver src/server.js). Excluir qualquer coisa, ou editar uma
// movimentação já registrada (corrigir histórico), fica reservado pra
// Líder/Gestor — mesmo espírito de "correção é ação supervisionada" já
// usado em Chamados.
const APENAS_LIDER_GESTOR = exigirPapel('lider', 'gestor');

function gerarId() {
  return crypto.randomUUID();
}

// Upload de termo já assinado (papel escaneado ou fotografado) — diferente
// de gerar/importar, aqui a pessoa manda o arquivo final pronto. Aceita PDF
// (mais comum, scanner) ou foto (JPEG/PNG/HEIC, quem só tem celular à mão).
// Nome salvo em disco é sempre gerado (nunca o nome original do upload) —
// mesmo motivo do upload de foto do CPD (não confiar em input de arquivo
// do navegador na hora de montar caminho no disco).
const TIPOS_ARQUIVO_TERMO = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};
// Leitura automática (OCR) de termo escaneado: o arquivo vai pra uma pasta
// temporária (dados/ocr-tmp), é lido e apagado — o termo só é guardado de
// verdade quando a pessoa confirma o envio (POST /estoque/termos/upload).
const PASTA_OCR_TMP = path.join(__dirname, '..', '..', 'dados', 'ocr-tmp');
fs.mkdirSync(PASTA_OCR_TMP, { recursive: true });
const uploadLeitura = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PASTA_OCR_TMP),
    filename: (req, file, cb) => cb(null, `leitura-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${TIPOS_ARQUIVO_TERMO[file.mimetype] || ''}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!TIPOS_ARQUIVO_TERMO[file.mimetype]),
});
// Resultado da última leitura de cada arquivo, por alguns minutos — a tela
// pede o cruzamento com os equipamentos da pessoa só depois de saber quem é.
const leiturasRecentes = new Map();
const VALIDADE_LEITURA_MS = 20 * 60 * 1000;
function guardarLeitura(interpretacao) {
  const agora = Date.now();
  for (const [k, v] of leiturasRecentes) if (agora - v.em > VALIDADE_LEITURA_MS) leiturasRecentes.delete(k);
  const id = crypto.randomUUID();
  leiturasRecentes.set(id, { interpretacao, em: agora });
  return id;
}

const uploadTermo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PASTA_TERMOS),
    filename: (req, file, cb) => cb(null, `termo-upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${TIPOS_ARQUIVO_TERMO[file.mimetype] || ''}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB — folga pra PDF escaneado em boa resolução
  fileFilter: (req, file, cb) => {
    if (!TIPOS_ARQUIVO_TERMO[file.mimetype]) {
      return cb(new Error('Formato não suportado — envie PDF, JPEG, PNG, WEBP ou HEIC.'));
    }
    cb(null, true);
  },
});

function estoqueRouter(db) {
  const router = express.Router();

  // --- Itens (catálogo principal, com saldo/status calculados) -----------
  // Cálculo de saldo/status mora em src/lib/estoqueResumo.js (compartilhado
  // com o dashboard e o envio de email — ver rotas /estoque/resumo abaixo).

  router.get('/estoque/itens', (req, res) => {
    res.json(calcularItensComSaldo(db));
  });

  router.post('/estoque/itens', (req, res) => {
    const { item, minimo = 0, statusManual = null } = req.body;
    if (!item || !item.trim()) {
      return res.status(400).json({ erro: 'Informe o nome do item.' });
    }
    const id = gerarId();
    db.prepare(`INSERT INTO estoque_itens (id, item, minimo, status_manual, auto) VALUES (?, ?, ?, ?, 0)`)
      .run(id, padronizarEquipamento(item, catalogoNomes()), Number(minimo) || 0, statusManual && statusManual.trim() ? statusManual.trim() : null);
    res.status(201).json(db.prepare(`SELECT * FROM estoque_itens WHERE id = ?`).get(id));
  });

  router.patch('/estoque/itens/:id', (req, res) => {
    const existente = db.prepare(`SELECT * FROM estoque_itens WHERE id = ?`).get(req.params.id);
    if (!existente) return res.status(404).json({ erro: 'Item não encontrado.' });

    const minimo = req.body.minimo !== undefined ? Number(req.body.minimo) || 0 : existente.minimo;
    const statusManual = req.body.statusManual !== undefined
      ? (req.body.statusManual && req.body.statusManual.trim() ? req.body.statusManual.trim() : null)
      : existente.status_manual;

    db.prepare(`UPDATE estoque_itens SET minimo = ?, status_manual = ? WHERE id = ?`).run(minimo, statusManual, req.params.id);
    res.json(db.prepare(`SELECT * FROM estoque_itens WHERE id = ?`).get(req.params.id));
  });

  router.delete('/estoque/itens/:id', APENAS_LIDER_GESTOR, (req, res) => {
    const info = db.prepare(`DELETE FROM estoque_itens WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ erro: 'Item não encontrado.' });
    res.json({ ok: true });
  });

  // --- Usados/danificados --------------------------------------------------

  router.get('/estoque/usados', (req, res) => {
    res.json(db.prepare(`SELECT * FROM estoque_usados ORDER BY item COLLATE NOCASE`).all());
  });

  router.post('/estoque/usados', (req, res) => {
    const { item, quantidade = 0, estado = null, detalhes = null } = req.body;
    if (!item || !item.trim()) return res.status(400).json({ erro: 'Informe o nome do item.' });
    const id = gerarId();
    db.prepare(`INSERT INTO estoque_usados (id, item, quantidade, estado, detalhes) VALUES (?, ?, ?, ?, ?)`)
      .run(id, padronizarEquipamento(item, catalogoNomes()), Number(quantidade) || 0, estado, detalhes);
    res.status(201).json(db.prepare(`SELECT * FROM estoque_usados WHERE id = ?`).get(id));
  });

  router.delete('/estoque/usados/:id', APENAS_LIDER_GESTOR, (req, res) => {
    const info = db.prepare(`DELETE FROM estoque_usados WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ erro: 'Registro não encontrado.' });
    res.json({ ok: true });
  });

  // --- Movimentações (ledger único: entrada/saída de estoque + entrega/  --
  // --- devolução de colaborador — Movimentações e Entregas foram fundidas -
  // --- numa aba só, ver comentário grande em prisma/schema.sql) -----------

  // EMPRESTIMO (2026-10-02, "Empréstimo (home office)"): saída temporária
  // (ex.: notebook que leva pra casa toda semana, sem devolução registrada).
  // Fica no histórico mas NÃO entra em calcularItensComSaldo (tipo
  // desconhecido ali é ignorado) nem na rotatividade (só conta SAIDA), e não
  // cria item automático no catálogo — senão um empréstimo de um nome que
  // ainda não existe lá nasceria como item com saldo 0 marcado COMPRAR.
  const TIPOS_CRIAVEIS_DIRETO = ['ENTRADA', 'SAIDA', 'ENTREGA', 'EMPRESTIMO'];
  // Tipos que carregam quem está com o equipamento (usuario/host/departamento/
  // modelo/st). Só ENTREGA tem termo e entra em "Equipamentos por usuário".
  const TIPOS_COM_PESSOA = ['ENTREGA', 'EMPRESTIMO'];

  // normKey() já tira acento, então "SAÍDA" digitado cai em "SAIDA" aqui.
  function normalizarTipoMovimentacao(tipo) {
    return normKey(tipo);
  }

  // Cria o item automaticamente no catálogo (auto=1) se o nome ainda não
  // existir — mesmo comportamento de sempre, agora reaproveitado pelos 4
  // tipos de linha (ENTRADA/SAIDA/ENTREGA/DEVOLUCAO_COLABORADOR).
  // Nomes do catálogo, usados pra padronizar o que for digitado (ver
  // src/lib/padronizacaoEquipamentos.js).
  function catalogoNomes() {
    return db.prepare(`SELECT item FROM estoque_itens`).all().map((r) => r.item);
  }

  function garantirItemNoCatalogo(equipamento) {
    const chave = normKey(equipamento);
    // Compara sem acento/maiúscula dos DOIS lados (antes só um lado perdia o
    // acento, e item com acento — ex.: "CAMERA DE SEGURANÇA" — nunca batia).
    const jaExiste = catalogoNomes().some((nome) => normKey(nome) === chave);
    if (!jaExiste) {
      db.prepare(`INSERT INTO estoque_itens (id, item, minimo, status_manual, auto) VALUES (?, ?, 1, NULL, 1)`)
        .run(gerarId(), equipamento);
    }
  }

  router.get('/estoque/movimentacoes', (req, res) => {
    res.json(db.prepare(`SELECT * FROM estoque_movimentacoes ORDER BY data DESC, criado_em DESC`).all());
  });

  // tipo ENTRADA/SAIDA: só equipamento+quantidade (+descrição), sem pessoa.
  // tipo ENTREGA: equipamento entregue a um colaborador (usuario/host/
  // departamento/modelo/st/termo). Não dá pra criar DEVOLUCAO_COLABORADOR
  // por aqui de propósito — devolução sempre fecha uma ENTREGA específica
  // por ID (ver POST /estoque/movimentacoes/:id/devolver), nunca por nome
  // digitado à mão, pra não reintroduzir o problema de "casar por nome"
  // que esse desenho evita desde o início (ver src/lib/estoqueUsuarios.js).
  // Acha o colaborador pelo mesmo casamento de sempre (usuario normalizado,
  // caindo pro nome se usuario não vier — ver estoqueUsuarios.js); se
  // ninguém bater, cria um registro mínimo (origem='auto') só com o texto
  // digitado, pra não travar a geração automática do termo por falta de
  // cadastro. Fica incompleto de propósito (sem CPF/RG/endereço) — dá pra
  // completar depois em Colaboradores, e o próximo termo dessa pessoa já
  // sai com o dado certo.
  function resolverOuCriarColaboradorPorUsuario(usuarioTexto, departamento) {
    const chave = normKey(usuarioTexto);
    const encontrado = db.prepare(`SELECT id, usuario, nome FROM estoque_colaboradores`).all()
      .find((c) => normKey(c.usuario || c.nome) === chave);
    if (encontrado) return encontrado.id;
    const id = gerarId();
    db.prepare(`INSERT INTO estoque_colaboradores (id, nome, usuario, departamento, origem) VALUES (?, ?, ?, ?, 'auto')`)
      .run(id, usuarioTexto, usuarioTexto, departamento || null);
    return id;
  }

  router.post('/estoque/movimentacoes', async (req, res) => {
    const {
      data, descricao = null, quantidade,
      usuario = null, host = null, departamento = null, termo = false,
      termoJaAssinado = false,
    } = req.body;
    // Padrão de nomes (2026-10-09): equipamento/modelo/ST sempre padronizados
    // na gravação — ver src/lib/padronizacaoEquipamentos.js.
    const equipamentoDigitado = String(req.body.equipamento ?? '').trim();
    const equipamento = padronizarEquipamento(equipamentoDigitado, catalogoNomes());
    const modelo = padronizarModelo(req.body.modelo);
    const st = padronizarServiceTag(req.body.st);
    const tipo = normalizarTipoMovimentacao(req.body.tipo);
    if (!data || !TIPOS_CRIAVEIS_DIRETO.includes(tipo) || !equipamento || !equipamento.trim()) {
      return res.status(400).json({ erro: 'Informe data, tipo (Entrada no estoque/Saída do estoque/Entrega a colaborador/Empréstimo (home office)) e equipamento.' });
    }
    const qtd = Number(quantidade) || (tipo === 'ENTREGA' ? 1 : 0);
    if (!qtd) return res.status(400).json({ erro: 'Informe a quantidade.' });

    // termoJaAssinado (2026-10-05): registra equipamento que JÁ está com a
    // pessoa e cujo termo foi assinado/enviado fora da plataforma — não gera
    // termo novo, marca termo=1 e não desconta do saldo (afeta_saldo=0: o
    // equipamento já estava fora da prateleira). Só vale pra ENTREGA.
    const entregaHistorica = tipo === 'ENTREGA' && !!termoJaAssinado;

    const id = gerarId();
    db.prepare(
      `INSERT INTO estoque_movimentacoes (id, data, tipo, descricao, equipamento, quantidade, usuario, host, departamento, modelo, st, termo, afeta_saldo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, data, tipo, descricao, equipamento.trim(), qtd,
      TIPOS_COM_PESSOA.includes(tipo) ? usuario : null,
      TIPOS_COM_PESSOA.includes(tipo) ? host : null,
      TIPOS_COM_PESSOA.includes(tipo) ? departamento : null,
      TIPOS_COM_PESSOA.includes(tipo) && modelo && modelo.trim() ? modelo.trim() : null,
      TIPOS_COM_PESSOA.includes(tipo) ? st : null,
      tipo === 'ENTREGA' && (termo || entregaHistorica) ? 1 : 0,
      entregaHistorica ? 0 : 1
    );
    if (tipo !== 'EMPRESTIMO' && !entregaHistorica) garantirItemNoCatalogo(equipamento.trim());

    // Empréstimo (home office) novo pro mesmo equipamento da mesma pessoa =
    // o anterior já voltou (senão não teria como sair de novo): fecha o
    // empréstimo antigo em aberto, pra "Equipamentos em mãos" não acumular
    // uma linha por semana. Sem criar linha de devolução (não mexe no saldo).
    if (tipo === 'EMPRESTIMO' && usuario && usuario.trim()) {
      const chaveEquipamento = (m) => (m.st && m.st.trim() ? `ST:${normKey(m.st).replace(/\s+/g, '')}` : `EM:${normKey(m.equipamento)}|${normKey(m.modelo || '')}`);
      const novaChave = chaveEquipamento({ st, equipamento, modelo });
      const fecharAnterior = db.prepare(`UPDATE estoque_movimentacoes SET devolvido_em = ? WHERE id = ?`);
      for (const aberto of db.prepare(`SELECT * FROM estoque_movimentacoes WHERE tipo = 'EMPRESTIMO' AND devolvido_em IS NULL AND usuario IS NOT NULL AND id != ?`).all(id)) {
        if (normKey(aberto.usuario) === normKey(usuario) && chaveEquipamento(aberto) === novaChave) {
          fecharAnterior.run(new Date().toISOString(), aberto.id);
        }
      }
    }

    // Termo automático ao registrar entrega (2026-09-22) — uma entrega =
    // um termo na hora, sem precisar ir na aba Termos clicar "Gerar termo"
    // (que continua existindo, pra juntar várias pendências num termo só).
    // Falha na geração não derruba o registro da entrega — ela já foi
    // salva; só avisa no retorno, sem bloquear.
    let avisoTermo;
    let termoGerado = null;
    let colaboradorDoTermo = null;
    if (tipo === 'ENTREGA' && !entregaHistorica && !(usuario && usuario.trim())) {
      // Antes isso passava em silêncio: sem Usuário não há de quem gerar o termo.
      avisoTermo = 'Entrega registrada, mas o campo Usuário estava vazio — por isso o termo NÃO foi gerado. Preencha o usuário (ex.: aline.amorim) e gere o termo na aba Termos, na ficha do colaborador.';
    }
    if (entregaHistorica && usuario && usuario.trim()) {
      // Garante que a pessoa existe em Colaboradores (aba Termos) — sem gerar termo.
      resolverOuCriarColaboradorPorUsuario(usuario.trim(), departamento);
    } else if (tipo === 'ENTREGA' && usuario && usuario.trim()) {
      try {
        const colaboradorId = resolverOuCriarColaboradorPorUsuario(usuario.trim(), departamento);
        const itemGerado = {
          id,
          equipamento: equipamento.trim(),
          modelo: modelo && modelo.trim() ? modelo.trim() : null,
          st,
          quantidade: qtd,
        };
        colaboradorDoTermo = colaboradorId;
        termoGerado = await gerarTermoParaColaborador(db, { colaboradorId, itens: [itemGerado], gerarId });
      } catch (e) {
        avisoTermo = `Entrega registrada, mas não consegui gerar o termo automaticamente: ${e.message}`;
      }
    }

    const padronizado = equipamento !== equipamentoDigitado ? { de: equipamentoDigitado, para: equipamento } : undefined;
    res.status(201).json({
      ...db.prepare(`SELECT * FROM estoque_movimentacoes WHERE id = ?`).get(id),
      avisoTermo,
      padronizado,
      termoId: termoGerado ? termoGerado.id : undefined,
      colaboradorId: termoGerado ? colaboradorDoTermo : undefined,
    });
  });

  // Editar movimentação já registrada (2026-09-08) — antes só dava pra
  // apagar e cadastrar de novo. Bloqueada em 3 casos, pra não destoar de
  // algo já fechado/assinado (nesses casos, apagar-e-recriar continua
  // sendo o caminho, igual antes):
  //   1. já tem Termo de Responsabilidade (termo=1);
  //   2. já foi devolvida (devolvido_em preenchido);
  //   3. é ela mesma quem fechou uma devolução de outra linha (não dá pra
  //      editar o "evento gerado automaticamente" de uma devolução).
  router.patch('/estoque/movimentacoes/:id', APENAS_LIDER_GESTOR, (req, res) => {
    const existente = db.prepare(`SELECT * FROM estoque_movimentacoes WHERE id = ?`).get(req.params.id);
    if (!existente) return res.status(404).json({ erro: 'Movimentação não encontrada.' });

    if (!TIPOS_CRIAVEIS_DIRETO.includes(existente.tipo)) {
      return res.status(409).json({ erro: 'Esse tipo de movimentação (devolução) não pode ser editado diretamente — é gerado automaticamente ao registrar uma devolução.' });
    }
    if (existente.termo) {
      return res.status(409).json({ erro: 'Essa entrega já tem Termo de Responsabilidade gerado — não é possível editar. Exclua e cadastre de novo, se precisar.' });
    }
    if (existente.devolvido_em) {
      return res.status(409).json({ erro: 'Essa entrega já foi devolvida — não é possível editar. Exclua e cadastre de novo, se precisar.' });
    }
    const fechaOutra = db.prepare(`SELECT id FROM estoque_movimentacoes WHERE devolvido_movimentacao_id = ?`).get(existente.id);
    if (fechaOutra) {
      return res.status(409).json({ erro: 'Essa movimentação já fechou uma devolução — não é possível editar. Exclua e cadastre de novo, se precisar.' });
    }

    const tipo = req.body.tipo !== undefined ? normalizarTipoMovimentacao(req.body.tipo) : existente.tipo;
    if (!TIPOS_CRIAVEIS_DIRETO.includes(tipo)) {
      return res.status(400).json({ erro: 'Tipo inválido. Use Entrada no estoque, Saída do estoque, Entrega a colaborador ou Empréstimo (home office).' });
    }
    const data = req.body.data !== undefined ? req.body.data : existente.data;
    const equipamento = padronizarEquipamento(req.body.equipamento !== undefined ? req.body.equipamento : existente.equipamento, catalogoNomes());
    if (!data || !equipamento || !equipamento.trim()) {
      return res.status(400).json({ erro: 'Informe data e equipamento.' });
    }
    const quantidadeInformada = req.body.quantidade !== undefined ? Number(req.body.quantidade) : existente.quantidade;
    const qtd = quantidadeInformada || (tipo === 'ENTREGA' ? 1 : 0);
    if (!qtd) return res.status(400).json({ erro: 'Informe a quantidade.' });

    const descricao = req.body.descricao !== undefined ? req.body.descricao : existente.descricao;
    const usuario = req.body.usuario !== undefined ? req.body.usuario : existente.usuario;
    const host = req.body.host !== undefined ? req.body.host : existente.host;
    const departamento = req.body.departamento !== undefined ? req.body.departamento : existente.departamento;
    const modelo = padronizarModelo(req.body.modelo !== undefined ? req.body.modelo : existente.modelo);
    const st = padronizarServiceTag(req.body.st !== undefined ? req.body.st : existente.st);
    const termoNovo = req.body.termo !== undefined ? !!req.body.termo : !!existente.termo;

    db.prepare(
      `UPDATE estoque_movimentacoes
         SET data = ?, tipo = ?, descricao = ?, equipamento = ?, quantidade = ?,
             usuario = ?, host = ?, departamento = ?, modelo = ?, st = ?, termo = ?
       WHERE id = ?`
    ).run(
      data, tipo, descricao, equipamento.trim(), qtd,
      TIPOS_COM_PESSOA.includes(tipo) ? usuario : null,
      TIPOS_COM_PESSOA.includes(tipo) ? host : null,
      TIPOS_COM_PESSOA.includes(tipo) ? departamento : null,
      TIPOS_COM_PESSOA.includes(tipo) && modelo && modelo.trim() ? modelo.trim() : null,
      TIPOS_COM_PESSOA.includes(tipo) ? st : null,
      tipo === 'ENTREGA' && termoNovo ? 1 : 0,
      req.params.id
    );
    if (tipo !== 'EMPRESTIMO') garantirItemNoCatalogo(equipamento.trim());
    res.json(db.prepare(`SELECT * FROM estoque_movimentacoes WHERE id = ?`).get(req.params.id));
  });

  router.delete('/estoque/movimentacoes/:id', APENAS_LIDER_GESTOR, (req, res) => {
    const info = db.prepare(`DELETE FROM estoque_movimentacoes WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ erro: 'Movimentação não encontrada.' });
    res.json({ ok: true });
  });

  // Registrar devolução — fecha o ciclo de UMA linha ENTREGA específica
  // (por ID, sem tentar adivinhar por nome digitado). Cria a linha
  // DEVOLUCAO_COLABORADOR correspondente E marca devolvido_em/
  // devolvido_movimentacao_id na linha ENTREGA original, na mesma ação. É
  // essa combinação que "Equipamentos por usuário" usa pra saber que o
  // item saiu da posse da pessoa (ver src/lib/estoqueUsuarios.js).
  router.post('/estoque/movimentacoes/:id/devolver', (req, res) => {
    const entrega = db.prepare(`SELECT * FROM estoque_movimentacoes WHERE id = ? AND tipo IN ('ENTREGA', 'EMPRESTIMO')`).get(req.params.id);
    if (!entrega) return res.status(404).json({ erro: 'Entrega não encontrada.' });
    if (entrega.devolvido_em) return res.status(400).json({ erro: 'Essa entrega já foi marcada como devolvida.' });

    // Empréstimo (home office) nunca saiu do saldo, então devolver só fecha a
    // linha — sem criar DEVOLUCAO_COLABORADOR (que somaria no saldo).
    if (entrega.tipo === 'EMPRESTIMO') {
      db.prepare(`UPDATE estoque_movimentacoes SET devolvido_em = ? WHERE id = ?`).run(new Date().toISOString(), entrega.id);
      return res.json(db.prepare(`SELECT * FROM estoque_movimentacoes WHERE id = ?`).get(entrega.id));
    }

    const { data = new Date().toISOString().slice(0, 10) } = req.body || {};
    const movId = gerarId();
    const descricao = `Devolução de ${entrega.usuario || 'equipamento'}`;
    db.prepare(
      `INSERT INTO estoque_movimentacoes (id, data, tipo, descricao, equipamento, quantidade, usuario, host, departamento, modelo, st)
       VALUES (?, ?, 'DEVOLUCAO_COLABORADOR', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(movId, data, descricao, entrega.equipamento, entrega.quantidade, entrega.usuario, entrega.host, entrega.departamento, entrega.modelo, entrega.st);

    garantirItemNoCatalogo(entrega.equipamento);

    db.prepare(`UPDATE estoque_movimentacoes SET devolvido_em = ?, devolvido_movimentacao_id = ? WHERE id = ?`)
      .run(new Date().toISOString(), movId, entrega.id);

    res.json(db.prepare(`SELECT * FROM estoque_movimentacoes WHERE id = ?`).get(entrega.id));
  });

  // --- Equipamentos por usuário (substitui a antiga aba Hosts) -------------
  // Ver src/lib/estoqueUsuarios.js pra explicação do conceito.

  router.get('/estoque/equipamentos-por-usuario', (req, res) => {
    res.json(calcularEquipamentosPorUsuario(db));
  });

  // --- Colaboradores (dados de identidade usados no Termo) -----------------

  // ?arquivados=1 devolve só quem foi marcado ativo=0 ("arquivo morto" —
  // tem termo na base mas não bate mais com ninguém no AD, ver
  // src/lib/estoqueColaboradores.js). Sem o parâmetro, comportamento de
  // sempre: só quem está ativo, é o que a aba Termos normal usa.
  // ?q= (2026-10-05, tela Termos): busca por nome/usuário sem acento/maiúscula
  // e devolve no máximo 20 — a tela não lista todo mundo, só mostra quem foi
  // pesquisado. Sem q, comportamento de sempre (lista completa).
  router.get('/estoque/colaboradores', (req, res) => {
    const ativo = req.query.arquivados === '1' ? 0 : 1;
    let linhas = db.prepare(`SELECT * FROM estoque_colaboradores WHERE ativo = ? ORDER BY nome COLLATE NOCASE`).all(ativo);
    const q = normKey(req.query.q || '');
    if (req.query.q !== undefined) {
      linhas = q.length >= 2
        ? linhas.filter((c) => normKey(c.nome).includes(q) || normKey(c.usuario || '').includes(q)).slice(0, 20)
        : [];
    }
    res.json(linhas);
  });

  router.post('/estoque/colaboradores', (req, res) => {
    const { nome, usuario = null, cpf = null, rg = null, telefone = null, nacionalidade = null, estadoCivil = null, endereco = null, cargo = null, departamento = null, origem = 'manual' } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Informe o nome do colaborador.' });
    const id = gerarId();
    db.prepare(
      `INSERT INTO estoque_colaboradores (id, nome, usuario, cpf, rg, telefone, nacionalidade, estado_civil, endereco, cargo, departamento, origem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, nome.trim(), usuario, cpf, rg, telefone, nacionalidade, estadoCivil, endereco, cargo, departamento, origem);
    res.status(201).json(db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(id));
  });

  // Mapa campo do corpo da requisição → coluna no banco (a maioria é igual;
  // só estadoCivil muda pra estado_civil).
  const COLUNAS_COLABORADOR = {
    nome: 'nome', usuario: 'usuario', cpf: 'cpf', rg: 'rg', telefone: 'telefone', nacionalidade: 'nacionalidade',
    estadoCivil: 'estado_civil', endereco: 'endereco', cargo: 'cargo', departamento: 'departamento',
  };

  router.patch('/estoque/colaboradores/:id', (req, res) => {
    const existente = db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(req.params.id);
    if (!existente) return res.status(404).json({ erro: 'Colaborador não encontrado.' });

    const valores = {};
    for (const [campo, coluna] of Object.entries(COLUNAS_COLABORADOR)) {
      if (req.body[campo] !== undefined) valores[coluna] = req.body[campo];
    }
    const colunas = Object.keys(valores);
    if (colunas.length) {
      db.prepare(`UPDATE estoque_colaboradores SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...colunas.map((c) => valores[c]), req.params.id);
    }
    res.json(db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(req.params.id));
  });

  router.delete('/estoque/colaboradores/:id', APENAS_LIDER_GESTOR, (req, res) => {
    const info = db.prepare(`DELETE FROM estoque_colaboradores WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ erro: 'Colaborador não encontrado.' });
    res.json({ ok: true });
  });

  // Equipamentos que este colaborador tem em mãos agora (mesma fonte da aba
  // Equipamentos por usuário) — usado pela tela de "escolher o que entra no
  // termo" antes de gerar (ver POST /estoque/termos abaixo). Cada item já
  // vem com `termo` (já foi incluído nalgum termo assinado antes?) pra
  // pré-marcar só o que ainda não foi assinado.
  router.get('/estoque/colaboradores/:id/equipamentos', (req, res) => {
    const colaborador = db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(req.params.id);
    if (!colaborador) return res.status(404).json({ erro: 'Colaborador não encontrado.' });
    const chave = normKey(colaborador.usuario || colaborador.nome);
    const grupo = calcularEquipamentosPorUsuario(db).find((g) => normKey(g.usuario) === chave);
    res.json(anexarTermosAosItens(db, colaborador.id, grupo ? grupo.itens : []));
  });

  // Unificar cadastros duplicados da mesma pessoa (2026-10-16) — ver
  // src/lib/unificarColaboradores.js. A lista de "possíveis duplicados" é só
  // sugestão; quem escolhe o que unir é a pessoa na tela. Apaga cadastros, por
  // isso só líder/gestor (mesma regra de excluir colaborador).
  router.get('/estoque/colaboradores/:id/possiveis-duplicados', (req, res) => {
    const existe = db.prepare(`SELECT id FROM estoque_colaboradores WHERE id = ?`).get(req.params.id);
    if (!existe) return res.status(404).json({ erro: 'Colaborador não encontrado.' });
    res.json(encontrarPossiveisDuplicados(db, req.params.id));
  });

  router.post('/estoque/colaboradores/:id/unificar', APENAS_LIDER_GESTOR, (req, res) => {
    try {
      res.json(unificarColaboradores(db, req.params.id, req.body.duplicadoIds));
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });

  // --- Termos de responsabilidade -------------------------------------------

  // ?colaboradorId= filtra os termos de uma pessoa só (tela Termos mostra os
  // termos somente depois de escolher o colaborador).
  router.get('/estoque/termos', (req, res) => {
    const base = `SELECT t.*, c.nome AS colaborador_nome, c.usuario AS colaborador_usuario
           FROM estoque_termos t JOIN estoque_colaboradores c ON c.id = t.colaborador_id`;
    if (req.query.colaboradorId) {
      return res.json(db.prepare(`${base} WHERE t.colaborador_id = ? ORDER BY COALESCE(t.data_assinatura, t.gerado_em) DESC`).all(req.query.colaboradorId));
    }
    res.json(db.prepare(`${base} ORDER BY t.gerado_em DESC`).all());
  });

  // Histórico (2026-10-05): termos de quem está em "arquivo morto" + todo
  // termo gerado pela própria plataforma (origem 'gerado'). Só responde a uma
  // busca por nome/usuário (mínimo 2 letras, no máximo 50 resultados) — de
  // propósito não existe "listar tudo".
  router.get('/estoque/termos/historico', (req, res) => {
    const q = normKey(req.query.q || '');
    if (q.length < 2) return res.json([]);
    const linhas = db
      .prepare(
        `SELECT t.*, c.nome AS colaborador_nome, c.usuario AS colaborador_usuario, c.ativo AS colaborador_ativo
         FROM estoque_termos t JOIN estoque_colaboradores c ON c.id = t.colaborador_id
         WHERE c.ativo = 0 OR t.origem = 'gerado'
         ORDER BY COALESCE(t.data_assinatura, t.gerado_em) DESC`
      )
      .all()
      .filter((t) => normKey(t.colaborador_nome).includes(q) || normKey(t.colaborador_usuario || '').includes(q))
      .slice(0, 50);
    res.json(linhas);
  });

  // Gera um termo novo pro colaborador indicado, só com os equipamentos
  // escolhidos em `itens` (a tela manda a seleção feita a partir de GET
  // .../equipamentos acima — ver public/app.js, abrirSelecaoTermo). Sem
  // `itens` no corpo (chamada antiga/externa), cai pro que essa pessoa tem
  // agora que AINDA NÃO foi incluído em nenhum termo anterior (campo
  // `termo` na movimentação) — nunca a lista inteira de novo, senão todo
  // "Gerar termo" reincluiria equipamento que ela já assinou antes.
  router.post('/estoque/termos', async (req, res) => {
    const colaborador = db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(req.body.colaboradorId);
    if (!colaborador) return res.status(400).json({ erro: 'Colaborador não encontrado.' });

    let itens = req.body.itens;
    if (!itens) {
      const chave = normKey(colaborador.usuario || colaborador.nome);
      const entregas = calcularEquipamentosPorUsuario(db).find((g) => normKey(g.usuario) === chave);
      itens = entregas ? entregas.itens.filter((i) => !i.termo) : [];
    }
    if (!itens.length) {
      return res.status(400).json({
        erro: 'Nenhum equipamento selecionado — ou nada novo pra assinar (o que ela tem já está coberto por um termo anterior).',
      });
    }

    try {
      const termoGerado = await gerarTermoParaColaborador(db, { colaboradorId: colaborador.id, itens, gerarId });
      res.status(201).json(termoGerado);
    } catch (e) {
      res.status(500).json({ erro: `Não consegui gerar o termo: ${e.message}` });
    }
  });

  // Dá baixa em equipamentos em posse de um colaborador (usado pelo Termo de
  // Devolução gerado e pelo envio de Termo de Devolução assinado). Cada item
  // é uma linha ENTREGA/EMPRESTIMO ainda aberta (mesma lógica do POST
  // /estoque/movimentacoes/:id/devolver, em lote): ENTREGA gera a linha
  // DEVOLUCAO_COLABORADOR (volta pro saldo) e fecha a original; EMPRESTIMO
  // (home office) nunca saiu do saldo, então só fecha a linha.
  function darBaixaDeEquipamentos(itens, descricaoDevolucao) {
    const hoje = new Date().toISOString().slice(0, 10);
    for (const item of itens) {
      const entregaOriginal = db.prepare(`SELECT * FROM estoque_movimentacoes WHERE id = ?`).get(item.id);
      if (entregaOriginal.tipo === 'EMPRESTIMO') {
        db.prepare(`UPDATE estoque_movimentacoes SET devolvido_em = ? WHERE id = ?`).run(new Date().toISOString(), item.id);
        continue;
      }
      const movId = gerarId();
      db.prepare(
        `INSERT INTO estoque_movimentacoes (id, data, tipo, descricao, equipamento, quantidade, usuario, host, departamento, modelo, st)
         VALUES (?, ?, 'DEVOLUCAO_COLABORADOR', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        movId, hoje, descricaoDevolucao,
        item.equipamento, item.quantidade,
        entregaOriginal.usuario, entregaOriginal.host, entregaOriginal.departamento, entregaOriginal.modelo, entregaOriginal.st
      );
      garantirItemNoCatalogo(item.equipamento);
      db.prepare(`UPDATE estoque_movimentacoes SET devolvido_em = ?, devolvido_movimentacao_id = ? WHERE id = ?`)
        .run(new Date().toISOString(), movId, item.id);
    }
  }

  // Gera o Termo de Devolução de Equipamentos (ver src/lib/termoPdf.js).
  // Junto com o PDF, já marca como devolvidas TODAS as entregas em aberto
  // desse colaborador (mesmo efeito do botão "Registrar devolução" na aba
  // Movimentações, um por um) — fecha o ciclo inteiro numa ação só.
  // "motivo" (2026-09-08): nem toda devolução é desligamento — 'outro' tira
  // a menção a desligamento e o campo "Data de Desligamento" do texto do
  // termo (ver gerarPdfTermoDevolucao). Default 'desligamento' por
  // compatibilidade com quem ainda chama essa rota sem mandar o campo.
  router.post('/estoque/termos/devolucao', async (req, res) => {
    const colaborador = db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(req.body.colaboradorId);
    if (!colaborador) return res.status(400).json({ erro: 'Colaborador não encontrado.' });

    const motivo = req.body.motivo === 'outro' ? 'outro' : 'desligamento';
    const dataDesligamento = motivo === 'desligamento' ? (req.body.dataDesligamento || null) : null;
    const hoje = new Date().toISOString().slice(0, 10);
    const dataDevolucaoFmt = new Date().toLocaleDateString('pt-BR');

    const chave = normKey(colaborador.usuario || colaborador.nome);
    const grupo = calcularEquipamentosPorUsuario(db).find((g) => normKey(g.usuario) === chave);
    const todasAbertas = grupo ? grupo.itens : [];

    // Escolha de equipamento (2026-10-01, pedido explícito — antes devolvia
    // tudo de uma vez só). req.body.itens = ids escolhidos na tela; sempre
    // re-deriva os dados de verdade a partir do que está aberto pra essa
    // pessoa (não confia em equipamento/modelo/quantidade vindo do
    // cliente — só o id escolhe QUAL, o resto vem do servidor). Sem
    // itens no corpo: mantém o comportamento antigo (devolve tudo),
    // compatibilidade com quem ainda chama essa rota sem selecionar.
    let entregasAbertas = todasAbertas;
    if (Array.isArray(req.body.itens)) {
      const idsEscolhidos = new Set(req.body.itens.map((i) => i.id));
      entregasAbertas = todasAbertas.filter((i) => idsEscolhidos.has(i.id));
    }

    if (!entregasAbertas.length) {
      return res.status(400).json({ erro: 'Nenhum equipamento selecionado (ou nada em aberto pra essa pessoa).' });
    }

    const itensParaDocx = entregasAbertas.map((i) => ({ ...i, estadoConservacao: 'Íntegro', dataDevolucao: dataDevolucaoFmt }));
    const dados = {
      nome: colaborador.nome,
      cargo: colaborador.cargo,
      departamento: colaborador.departamento,
      motivo,
      dataDesligamento,
    };

    try {
      const arquivo = await gerarArquivoTermoDevolucao({ dados, itens: itensParaDocx });

      darBaixaDeEquipamentos(
        entregasAbertas,
        motivo === 'desligamento' ? `Devolução (desligamento) de ${colaborador.usuario || colaborador.nome}` : `Devolução de ${colaborador.usuario || colaborador.nome}`
      );

      const id = gerarId();
      db.prepare(`INSERT INTO estoque_termos (id, colaborador_id, tipo, itens_snapshot, arquivo, origem) VALUES (?, ?, 'devolucao', ?, ?, 'gerado')`)
        .run(id, colaborador.id, JSON.stringify(itensParaDocx), arquivo);
      res.status(201).json(db.prepare(`SELECT * FROM estoque_termos WHERE id = ?`).get(id));
    } catch (e) {
      res.status(500).json({ erro: `Não consegui gerar o termo de devolução: ${e.message}` });
    }
  });

  // --- Leitura automática do termo escaneado (OCR local, Tesseract) -----------
  // Só SUGERE (tipo, quem é, equipamentos da tabela); nada é gravado aqui. Ver
  // src/lib/ocrTermo.js. Sem Tesseract instalado no servidor devolve
  // { disponivel: false, motivo } e a tela segue sem sugestão.
  router.get('/estoque/termos/ocr-status', async (req, res) => {
    res.json(await statusOcr());
  });

  function itensEmMaosDoColaborador(colaborador) {
    const chave = normKey(colaborador.usuario || colaborador.nome);
    const grupo = calcularEquipamentosPorUsuario(db).find((g) => normKey(g.usuario) === chave);
    return grupo ? grupo.itens : [];
  }

  router.post('/estoque/termos/ler', (req, res) => {
    uploadLeitura.single('arquivo')(req, res, async (err) => {
      if (err) return res.status(400).json({ erro: err.message });
      if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo PDF, JPEG ou PNG.' });
      try {
        const leitura = await lerArquivo(req.file.path, req.file.mimetype);
        if (!leitura.disponivel) return res.json({ disponivel: false, motivo: leitura.motivo });
        const colaboradores = db.prepare(`SELECT id, nome, usuario, ativo FROM estoque_colaboradores`).all();
        const colaborador = req.body.colaboradorId ? colaboradores.find((c) => c.id === req.body.colaboradorId) : null;
        const resposta = {
          disponivel: true,
          leituraId: guardarLeitura(leitura),
          tipoSugerido: leitura.tipoSugerido,
          nomeLido: leitura.nomeLido,
          itensLidos: leitura.itensLidos,
          paginasLidas: leitura.paginasLidas,
          colaboradoresSugeridos: sugerirColaboradores(leitura, colaboradores),
        };
        if (colaborador) Object.assign(resposta, correspondenciasComEquipamentos(leitura, itensEmMaosDoColaborador(colaborador)));
        res.json(resposta);
      } catch (e) {
        res.status(500).json({ erro: `Não consegui ler o documento: ${e.message}` });
      } finally {
        fs.unlink(req.file.path, () => {});
      }
    });
  });

  router.get('/estoque/termos/ler/:leituraId/correspondencias', (req, res) => {
    const guardada = leiturasRecentes.get(req.params.leituraId);
    if (!guardada) return res.status(404).json({ erro: 'Essa leitura expirou — escolha o arquivo de novo.' });
    const colaborador = db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(req.query.colaboradorId);
    if (!colaborador) return res.status(404).json({ erro: 'Colaborador não encontrado.' });
    res.json(correspondenciasComEquipamentos(guardada.interpretacao, itensEmMaosDoColaborador(colaborador)));
  });

  // Sobe um termo já assinado (PDF escaneado ou foto) pro colaborador
  // indicado — sem gerar nada, só registra o arquivo final que já existe.
  // itens_snapshot fica vazio (não dá pra saber a lista de equipamentos só
  // olhando um arquivo escaneado) — quem quiser essa lista pode gerar um
  // termo separado com o botão "Gerar termo", que já lê o que a pessoa tem
  // agora em Equipamentos por usuário.
  router.post('/estoque/termos/upload', (req, res) => {
    uploadTermo.single('arquivo')(req, res, (err) => {
      if (err) return res.status(400).json({ erro: err.message });
      if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo.' });

      const colaborador = db.prepare(`SELECT * FROM estoque_colaboradores WHERE id = ?`).get(req.body.colaboradorId);
      if (!colaborador) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ erro: 'Colaborador não encontrado.' });
      }
      const tipo = req.body.tipo === 'devolucao' ? 'devolucao' : 'responsabilidade';

      // Vínculo com equipamentos (2026-10-09): o termo assinado enviado não diz
      // sozinho de quais equipamentos se trata. `itensIds` (JSON, opcional) =
      // ids das linhas ENTREGA/EMPRESTIMO em aberto que esse papel cobre.
      // Sempre re-deriva os dados a partir do que está aberto pra essa pessoa
      // (o cliente só escolhe QUAIS, pelo id). Responsabilidade: marca como
      // coberto por termo (✓). Devolução: dá baixa, igual ao termo de
      // devolução gerado pela plataforma. Sem itensIds: só arquiva o arquivo
      // (termo antigo / pessoa sem equipamento cadastrado).
      let itensVinculados = [];
      if (req.body.itensIds) {
        let ids;
        try {
          ids = JSON.parse(req.body.itensIds);
        } catch (e) {
          ids = null;
        }
        if (!Array.isArray(ids)) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ erro: 'Lista de equipamentos inválida.' });
        }
        const chave = normKey(colaborador.usuario || colaborador.nome);
        const grupo = calcularEquipamentosPorUsuario(db).find((g) => normKey(g.usuario) === chave);
        const abertos = grupo ? grupo.itens : [];
        const idsUnicos = new Set(ids);
        itensVinculados = abertos.filter((i) => idsUnicos.has(i.id));
        if (itensVinculados.length !== idsUnicos.size) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ erro: 'Algum equipamento escolhido não está mais em aberto pra essa pessoa — recarregue a tela e escolha de novo.' });
        }
      }

      // itensNovos (2026-10-16): equipamentos lidos no documento que a pessoa
      // ainda não tinha em mãos na plataforma — viram entrega "histórica"
      // (afeta_saldo = 0, termo = 1: já estavam com ela e o termo é este que
      // está sendo enviado), igual ao que a reconciliação de termos faz. Só em
      // termo de responsabilidade; ignora o que já está em mãos (mesma ST ou
      // mesmo equipamento+modelo).
      const novosParaRegistrar = [];
      if (req.body.itensNovos && tipo === 'responsabilidade') {
        let lista;
        try { lista = JSON.parse(req.body.itensNovos); } catch (e) { lista = null; }
        if (!Array.isArray(lista)) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ erro: 'Lista de equipamentos lidos inválida.' });
        }
        const emMaos = itensEmMaosDoColaborador(colaborador);
        const nomes = catalogoNomes();
        const jaTem = (i) => emMaos.some((m) => (i.st && m.st && padronizarServiceTag(m.st) === i.st) || (!i.st && !m.st && normKey(m.equipamento) === normKey(i.equipamento) && normKey(m.modelo || '') === normKey(i.modelo || '')));
        for (const bruto of lista.slice(0, 20)) {
          const novo = {
            equipamento: padronizarEquipamento(bruto && bruto.equipamento, nomes),
            modelo: padronizarModelo(bruto && bruto.modelo),
            st: padronizarServiceTag(bruto && bruto.st),
            quantidade: Number(bruto && bruto.quantidade) > 0 ? Math.min(Number(bruto.quantidade), 99) : 1,
          };
          if (!novo.equipamento || jaTem(novo) || novosParaRegistrar.some((x) => (x.st && x.st === novo.st) || (!x.st && !novo.st && x.equipamento === novo.equipamento && x.modelo === novo.modelo))) continue;
          novosParaRegistrar.push({ ...novo, id: gerarId() });
        }
      }

      const snapshot = [
        ...itensVinculados.map((i) => ({ id: i.id, equipamento: i.equipamento, modelo: i.modelo, st: i.st, quantidade: i.quantidade })),
        ...novosParaRegistrar,
      ];
      const id = gerarId();
      db.exec('BEGIN');
      try {
        const hojeSp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
        for (const n of novosParaRegistrar) {
          db.prepare(
            `INSERT INTO estoque_movimentacoes (id, data, tipo, descricao, equipamento, quantidade, usuario, departamento, modelo, st, termo, afeta_saldo)
             VALUES (?, ?, 'ENTREGA', ?, ?, ?, ?, ?, ?, ?, 1, 0)`
          ).run(n.id, hojeSp, 'Equipamento lido do termo assinado enviado', n.equipamento, n.quantidade, colaborador.usuario || colaborador.nome, colaborador.departamento || null, n.modelo, n.st);
        }
        db.prepare(`INSERT INTO estoque_termos (id, colaborador_id, tipo, itens_snapshot, arquivo, origem) VALUES (?, ?, ?, ?, ?, 'upload')`)
          .run(id, colaborador.id, tipo, JSON.stringify(snapshot), req.file.filename);
        if (tipo === 'responsabilidade') {
          const marcar = db.prepare(`UPDATE estoque_movimentacoes SET termo = 1 WHERE id = ?`);
          for (const item of itensVinculados) marcar.run(item.id);
        } else if (itensVinculados.length) {
          darBaixaDeEquipamentos(itensVinculados, `Devolução de ${colaborador.usuario || colaborador.nome} (termo assinado enviado)`);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        fs.unlink(req.file.path, () => {});
        return res.status(500).json({ erro: `Não consegui registrar o termo: ${e.message}` });
      }
      res.status(201).json({ ...db.prepare(`SELECT * FROM estoque_termos WHERE id = ?`).get(id), vinculados: itensVinculados.length, registrados: novosParaRegistrar.length });
    });
  });

  router.get('/estoque/termos/:id/arquivo', (req, res) => {
    const termo = db.prepare(`SELECT * FROM estoque_termos WHERE id = ?`).get(req.params.id);
    if (!termo || !termo.arquivo) return res.status(404).json({ erro: 'Arquivo do termo não encontrado.' });
    const caminho = path.join(PASTA_TERMOS, termo.arquivo);
    if (!fs.existsSync(caminho)) return res.status(404).json({ erro: 'Arquivo do termo não encontrado no disco.' });
    res.download(caminho, termo.arquivo);
  });

  router.delete('/estoque/termos/:id', APENAS_LIDER_GESTOR, (req, res) => {
    const info = db.prepare(`DELETE FROM estoque_termos WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ erro: 'Termo não encontrado.' });
    res.json({ ok: true });
  });

  // --- Consultores (celular/tablet corporativo de externos) ----------------

  router.get('/estoque/consultores', (req, res) => {
    res.json(db.prepare(`SELECT * FROM estoque_consultores ORDER BY usuario COLLATE NOCASE`).all());
  });

  router.post('/estoque/consultores', (req, res) => {
    const { usuario = null, departamento = null, numeroCelular = null, numeroTablet = null, gmail = null, imei = null, iccid = null } = req.body;
    if (!usuario || !usuario.trim()) return res.status(400).json({ erro: 'Informe o nome do consultor.' });
    const id = gerarId();
    db.prepare(
      `INSERT INTO estoque_consultores (id, usuario, departamento, numero_celular, numero_tablet, gmail, imei, iccid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, usuario.trim(), departamento, numeroCelular, numeroTablet, gmail, imei, iccid);
    res.status(201).json(db.prepare(`SELECT * FROM estoque_consultores WHERE id = ?`).get(id));
  });

  router.delete('/estoque/consultores/:id', APENAS_LIDER_GESTOR, (req, res) => {
    const info = db.prepare(`DELETE FROM estoque_consultores WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ erro: 'Registro não encontrado.' });
    res.json({ ok: true });
  });

  // --- Corporativos (linha/aparelho por departamento, sem pessoa fixa) -----

  router.get('/estoque/corporativos', (req, res) => {
    res.json(db.prepare(`SELECT * FROM estoque_corporativos ORDER BY item COLLATE NOCASE`).all());
  });

  router.post('/estoque/corporativos', (req, res) => {
    const { item, departamento = null, numero = null, st = null, gmail = null, imei = null } = req.body;
    if (!item || !item.trim()) return res.status(400).json({ erro: 'Informe o nome/identificação do item.' });
    const id = gerarId();
    db.prepare(`INSERT INTO estoque_corporativos (id, item, departamento, numero, st, gmail, imei) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, item.trim(), departamento, numero, st, gmail, imei);
    res.status(201).json(db.prepare(`SELECT * FROM estoque_corporativos WHERE id = ?`).get(id));
  });

  router.delete('/estoque/corporativos/:id', APENAS_LIDER_GESTOR, (req, res) => {
    const info = db.prepare(`DELETE FROM estoque_corporativos WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ erro: 'Registro não encontrado.' });
    res.json({ ok: true });
  });

  // --- Dashboard / resumo por email ----------------------------------------
  // Mesmo cálculo usado pelo envio semanal agendado (scripts/enviar-resumo-estoque.js).

  router.get('/estoque/resumo', (req, res) => {
    res.json(calcularResumoEstoque(db));
  });

  router.post('/estoque/resumo/email', async (req, res) => {
    try {
      const resumo = calcularResumoEstoque(db);
      const { assunto, texto, html } = formatarResumoEmail(resumo);
      const enviadoPara = await enviarEmail({ assunto, texto, html });
      res.json({ ok: true, enviadoPara });
    } catch (e) {
      res.status(502).json({ erro: e.message });
    }
  });

  return router;
}

module.exports = { estoqueRouter };
