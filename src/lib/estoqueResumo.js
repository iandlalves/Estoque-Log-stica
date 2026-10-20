// Resumo/dashboard do estoque — usado tanto pela tela (GET /api/estoque/resumo
// e o botão "Enviar resumo por email agora") quanto pelo envio semanal
// agendado (scripts/enviar-resumo-estoque.js, fora do Express). Fica num
// módulo à parte porque o script agendado não pode importar de dentro de
// src/routes/estoque.js sem também montar um router inteiro.
//
// calcularItensComSaldo: saldo = soma(ENTRADA + DEVOLUCAO_COLABORADOR) -
// soma(SAIDA + ENTREGA) por nome de item, "COMPRAR" se saldo < mínimo.
// Saldo representa o que ainda está disponível na prateleira — ENTREGA
// desconta (o item saiu fisicamente pra mão de um colaborador) e
// DEVOLUCAO_COLABORADOR devolve (voltou pra prateleira), simétrico.
//
// Mudou em 2026-08-31 (pedido explícito): antes ENTREGA não descontava
// nada — só ENTRADA/SAÍDA mexiam no saldo, e DEVOLUCAO_COLABORADOR somava
// de volta sozinho, o que inflava o saldo a cada ciclo de entrega+devolução
// (dava pra entregar um item e ele continuar contando como "disponível").
// Não afeta o histórico: como as Movimentações foram zeradas nessa mesma
// data (ver scripts/zerar-movimentacoes.js), toda entrega/devolução daqui
// pra frente já nasce com a semântica nova, sem precisar recalcular nada
// retroativo. Legado 'DEVOLUÇÃO' (com acento, sem pessoa vinculada)
// continua fora do cálculo — não dá pra saber se equivale a uma entrega
// anterior ou não.

function normKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .trim()
    .toUpperCase();
}

function escHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Rotatividade = quantas vezes o item SAIU do estoque (tipo SAIDA, só isso —
// entrada/entrega/devolução não contam) NESTE MÊS corrente até agora. Não é
// mais relativo aos outros itens (terço/percentil) — é um limiar fixo,
// pedido explícito: 3 saídas ou mais no mês = alta; 2 = média; 0 ou 1 = sem
// rotatividade. Reseta sozinho a cada mês novo (não acumula "desde sempre").
const LIMIAR_ALTA_ROTATIVIDADE = 3; // saídas no mês corrente
const LIMIAR_MEDIA_ROTATIVIDADE = 2; // saídas no mês corrente

function classificarRotatividade(itensComSaidasMes) {
  return itensComSaidasMes.map((i) => {
    let rotatividade = 'nenhuma';
    if (i.saidasMes >= LIMIAR_ALTA_ROTATIVIDADE) rotatividade = 'alta';
    else if (i.saidasMes >= LIMIAR_MEDIA_ROTATIVIDADE) rotatividade = 'media';
    return { ...i, rotatividade };
  });
}

function calcularItensComSaldo(db) {
  const itens = db.prepare(`SELECT * FROM estoque_itens ORDER BY item COLLATE NOCASE`).all();
  const movs = db.prepare(`SELECT tipo, equipamento, quantidade, afeta_saldo FROM estoque_movimentacoes`).all();

  const inicioMes = new Date();
  inicioMes.setDate(1);
  const inicioMesStr = inicioMes.toISOString().slice(0, 10);
  const saidasMesRows = db
    .prepare(`SELECT equipamento, COUNT(*) AS n FROM estoque_movimentacoes WHERE tipo = 'SAIDA' AND data >= ? GROUP BY equipamento`)
    .all(inicioMesStr);
  const saidasMesPorChave = new Map();
  for (const r of saidasMesRows) {
    const chave = normKey(r.equipamento);
    saidasMesPorChave.set(chave, (saidasMesPorChave.get(chave) || 0) + r.n);
  }

  const saldosPorChave = new Map();
  for (const m of movs) {
    const chave = normKey(m.equipamento);
    const tipo = normKey(m.tipo);
    if (tipo === 'ENTREGA' && m.afeta_saldo === 0) continue; // entrega histórica: já estava fora do estoque
    const atual = saldosPorChave.get(chave) || 0;
    if (tipo === 'ENTRADA' || tipo === 'DEVOLUCAO_COLABORADOR') saldosPorChave.set(chave, atual + m.quantidade);
    else if (tipo === 'SAIDA' || tipo === 'SAÍDA' || tipo === 'ENTREGA') saldosPorChave.set(chave, atual - m.quantidade);
    // DEVOLUÇÃO (legado, sem pessoa vinculada) não entra no saldo — não dá
    // pra saber se corresponde a uma entrega anterior já contabilizada.
  }

  const comSaldo = itens.map((i) => {
    const chave = normKey(i.item);
    const saldo = saldosPorChave.get(chave) || 0;
    const status = (i.status_manual && i.status_manual.trim())
      ? i.status_manual.trim()
      : (saldo < i.minimo ? 'COMPRAR' : 'OK');
    const saidasMes = saidasMesPorChave.get(chave) || 0;
    return { ...i, saldo, status, saidasMes };
  });

  return classificarRotatividade(comSaldo);
}

// Categorias sempre acompanhadas no dashboard/email, independente de
// precisarem comprar ou não (pedido explícito — equipamentos que a equipe
// considera essenciais de ter sempre à mão). Lista fixa, uma linha por
// categoria — não é mais "toda variante que bate com esse prefixo vira uma
// linha própria" (isso mostrava cada modelo de notebook/headset separado).
//
// - tipo 'exato': casa 1:1 com um item do catálogo pelo nome normalizado
//   (sem acento/maiúscula). Sem esse item cadastrado ainda, a categoria
//   aparece vazia ("nenhum item cadastrado").
// - tipo 'agregado': soma o saldo de TODOS os itens cujo nome começa com
//   `prefixo` (ex.: todo modelo de notebook) numa linha só, comparando
//   contra um mínimo fixo (não a soma dos mínimos individuais) — o mínimo
//   de notebooks em estoque, como categoria, é 2, independente de quantos
//   modelos existam por baixo.
const CATEGORIAS_CRITICAS = [
  { categoria: 'Notebook', tipo: 'agregado', prefixo: 'NOTEBOOK', minimoFixo: 2 },
  { categoria: 'Headset Avaya Central', tipo: 'exato', nome: 'HEADSET AVAYA CENTRAL' },
  { categoria: 'Headset RJ', tipo: 'exato', nome: 'HEADSET RJ' },
  { categoria: 'Headset USB', tipo: 'exato', nome: 'HEADSET USB' },
  { categoria: 'Headset Zone 300', tipo: 'exato', nome: 'HEADSET ZONE 300' },
  { categoria: 'Monitor', tipo: 'exato', nome: 'MONITOR' },
  { categoria: 'Mouse cabeado', tipo: 'exato', nome: 'MOUSES' },
  { categoria: 'Mouse bluetooth', tipo: 'exato', nome: 'MOUSE BLUETOOTH' },
  { categoria: 'Teclado cabeado', tipo: 'exato', nome: 'TECLADO' },
  { categoria: 'Teclado bluetooth', tipo: 'exato', nome: 'TECLADO BLUETOOTH' },
  { categoria: 'Câmera 4K', tipo: 'exato', nome: 'CAMERA 4K' },
];

function itensCriticosPorCategoria(itensComSaldo) {
  return CATEGORIAS_CRITICAS.map((def) => {
    if (def.tipo === 'agregado') {
      const modelos = itensComSaldo.filter((i) => normKey(i.item).startsWith(def.prefixo));
      const saldo = modelos.reduce((soma, i) => soma + i.saldo, 0);
      const status = saldo < def.minimoFixo ? 'COMPRAR' : 'OK';
      return {
        categoria: def.categoria,
        itens: [{ item: def.categoria, saldo, minimo: def.minimoFixo, status, modelos: modelos.length }],
      };
    }
    const item = itensComSaldo.find((i) => normKey(i.item) === normKey(def.nome));
    return { categoria: def.categoria, itens: item ? [item] : [] };
  });
}

function calcularResumoEstoque(db) {
  const itensComSaldo = calcularItensComSaldo(db);
  const itensCriticos = itensCriticosPorCategoria(itensComSaldo);

  // Itens que pertencem a uma categoria "agregada" (hoje só Notebook) saem
  // da lista item-a-item de "precisando comprar" — quem representa esse
  // grupo ali é a própria linha agregada da categoria (uma linha "Notebook"
  // só, não um modelo de cada vez), igual já é em "itens importantes".
  const prefixosAgregados = CATEGORIAS_CRITICAS.filter((d) => d.tipo === 'agregado').map((d) => d.prefixo);
  const linhasAgregadasParaComprar = itensCriticos
    .map((cat) => cat.itens[0])
    .filter((i) => i && i.modelos !== undefined && i.status === 'COMPRAR');

  const itensComprar = [
    ...linhasAgregadasParaComprar,
    ...itensComSaldo.filter((i) => i.status === 'COMPRAR' && !prefixosAgregados.some((p) => normKey(i.item).startsWith(p))),
  ].sort((a, b) => (b.minimo - b.saldo) - (a.minimo - a.saldo));

  const inicioMes = new Date();
  inicioMes.setDate(1);
  const inicioMesStr = inicioMes.toISOString().slice(0, 10);
  const totalMovimentacoesMes = db
    .prepare(`SELECT COUNT(*) AS n FROM estoque_movimentacoes WHERE data >= ?`)
    .get(inicioMesStr).n;

  const totalUsados = db.prepare(`SELECT COUNT(*) AS n FROM estoque_usados`).get().n;
  const totalEntregas = db.prepare(`SELECT COUNT(*) AS n FROM estoque_movimentacoes WHERE tipo = 'ENTREGA'`).get().n;
  const entregasAbertas = db.prepare(`SELECT COUNT(*) AS n FROM estoque_movimentacoes WHERE tipo = 'ENTREGA' AND devolvido_em IS NULL`).get().n;
  const totalConsultores = db.prepare(`SELECT COUNT(*) AS n FROM estoque_consultores`).get().n;
  const totalCorporativos = db.prepare(`SELECT COUNT(*) AS n FROM estoque_corporativos`).get().n;

  // Colaboradores sem termo / sem termo assinado (2026-09-22) — só entre os
  // ATIVOS (quem está em arquivo morto não entra nessa cobrança, já é
  // histórico). "Assinado" = origem 'sharepoint' (veio da base real
  // importada, já assinado de verdade) ou 'upload' (atendente subiu o
  // escaneado/foto já assinado) — origem 'gerado' é só o PDF pronto pra
  // assinar, não é prova de que a assinatura realmente aconteceu. Todo
  // colaborador "sem termo" também conta como "sem termo assinado" (é um
  // superconjunto), de propósito.
  const ORIGENS_ASSINADO = new Set(['sharepoint', 'upload']);
  const colaboradoresAtivos = db.prepare(`SELECT id, nome, cargo, departamento FROM estoque_colaboradores WHERE ativo = 1 ORDER BY nome COLLATE NOCASE`).all();
  const termosPorColaborador = new Map();
  for (const t of db.prepare(`SELECT colaborador_id, origem, tipo FROM estoque_termos`).all()) {
    if (!termosPorColaborador.has(t.colaborador_id)) termosPorColaborador.set(t.colaborador_id, []);
    termosPorColaborador.get(t.colaborador_id).push(t);
  }
  const colaboradoresSemTermo = colaboradoresAtivos.filter((c) => !termosPorColaborador.has(c.id));
  // Só um termo de RESPONSABILIDADE assinado prova que a pessoa assinou o
  // recebimento (2026-10-09): um termo de devolução assinado não conta. A
  // situação diz por que a pessoa está na lista: nenhum termo; só termo
  // gerado (ainda não assinado); ou só termo de devolução.
  const colaboradoresSemTermoAssinado = colaboradoresAtivos
    .filter((c) => !(termosPorColaborador.get(c.id) || []).some((t) => t.tipo !== 'devolucao' && ORIGENS_ASSINADO.has(t.origem)))
    .map((c) => {
      const termos = termosPorColaborador.get(c.id);
      const situacao = !termos ? 'sem_termo' : termos.some((t) => t.tipo !== 'devolucao') ? 'gerado' : 'so_devolucao';
      return { ...c, situacao };
    });

  return {
    geradoEm: new Date().toISOString(),
    totalItens: itensComSaldo.length,
    itensComprar,
    itensCriticos,
    totalMovimentacoesMes,
    totalUsados,
    totalEntregas,
    entregasAbertas,
    totalConsultores,
    totalCorporativos,
    colaboradoresSemTermo,
    colaboradoresSemTermoAssinado,
  };
}

function formatarResumoEmail(resumo) {
  const assunto = resumo.itensComprar.length
    ? `Resumo semanal de estoque — ${resumo.itensComprar.length} item(ns) precisando comprar`
    : 'Resumo semanal de estoque — tudo OK';

  const linhasTexto = resumo.itensComprar.length
    ? resumo.itensComprar
        .map((i) => `  - ${i.item}${i.modelos ? ` (${i.modelos} modelos)` : ''}: saldo ${i.saldo}, mínimo ${i.minimo} (faltam ${Math.max(i.minimo - i.saldo, 0)})`)
        .join('\n')
    : '  Nenhum item abaixo do mínimo.';

  const criticosTexto = resumo.itensCriticos
    .map((cat) => {
      if (!cat.itens.length) return `  ${cat.categoria}: nenhum item cadastrado com esse nome ainda.`;
      const linhas = cat.itens
        .map((i) => `    - ${i.item}${i.modelos ? ` (${i.modelos} modelos)` : ''}: saldo ${i.saldo}, mínimo ${i.minimo}${i.status === 'COMPRAR' ? ' [COMPRAR]' : ` (${i.status})`}`)
        .join('\n');
      return `  ${cat.categoria}:\n${linhas}`;
    })
    .join('\n');

  // Ordem pedida: primeiro o que precisa de ação (comprar), depois o
  // acompanhamento geral dos itens importantes. Só os 3 totais que
  // continuam relevantes pro resumo semanal (itens no catálogo/consultores/
  // corporativos mudam pouco de uma semana pra outra — tiram foco do que
  // importa aqui).
  const texto = [
    `Resumo de estoque gerado em ${new Date(resumo.geradoEm).toLocaleString('pt-BR')}`,
    '',
    `Movimentações neste mês: ${resumo.totalMovimentacoesMes}`,
    `Entregas registradas: ${resumo.totalEntregas}`,
    `Usados/danificados: ${resumo.totalUsados}`,
    '',
    `>>> ITENS PRECISANDO COMPRAR (${resumo.itensComprar.length}) — AÇÃO NECESSÁRIA <<<`,
    linhasTexto,
    '',
    'Itens importantes (acompanhamento permanente):',
    criticosTexto,
  ].join('\n');

  const linhasHtml = resumo.itensComprar.length
    ? `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse; border-color:#c62828">
        <tr style="background:#fdecec"><th align="left">Item</th><th align="left">Saldo</th><th align="left">Mínimo</th><th align="left">Faltam</th></tr>
        ${resumo.itensComprar
          .map((i) => `<tr><td style="color:#c62828; font-weight:bold">${escHtml(i.item)}${i.modelos ? ` (${i.modelos} modelos)` : ''}</td><td>${i.saldo}</td><td>${i.minimo}</td><td>${Math.max(i.minimo - i.saldo, 0)}</td></tr>`)
          .join('')}
      </table>`
    : '<p>Nenhum item abaixo do mínimo.</p>';

  const criticosHtml = `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse">
    <tr><th align="left">Categoria</th><th align="left">Item</th><th align="left">Saldo</th><th align="left">Mínimo</th><th align="left">Status</th></tr>
    ${resumo.itensCriticos
      .map((cat) => (cat.itens.length
        ? cat.itens
            .map((i, idx) => `<tr><td>${idx === 0 ? escHtml(cat.categoria) : ''}</td><td>${escHtml(i.item)}${i.modelos ? ` (${i.modelos} modelos)` : ''}</td><td>${i.saldo}</td><td>${i.minimo}</td><td>${i.status === 'COMPRAR' ? '<strong style="color:#c62828">COMPRAR</strong>' : escHtml(i.status)}</td></tr>`)
            .join('')
        : `<tr><td>${escHtml(cat.categoria)}</td><td colspan="4">Nenhum item cadastrado com esse nome ainda.</td></tr>`))
      .join('')}
  </table>`;

  const html = `
    <h2>Resumo de estoque</h2>
    <p>Gerado em ${escHtml(new Date(resumo.geradoEm).toLocaleString('pt-BR'))}</p>
    <ul>
      <li>Movimentações neste mês: ${resumo.totalMovimentacoesMes}</li>
      <li>Entregas registradas: ${resumo.totalEntregas}</li>
      <li>Usados/danificados: ${resumo.totalUsados}</li>
    </ul>
    <h3 style="color:#c62828">Itens precisando comprar (${resumo.itensComprar.length})</h3>
    ${linhasHtml}
    <h3>Itens importantes (acompanhamento permanente)</h3>
    ${criticosHtml}
  `;

  return { assunto, texto, html };
}

module.exports = { normKey, calcularItensComSaldo, calcularResumoEstoque, formatarResumoEmail };
