// "Equipamentos por usuário" — substitui a antiga aba Hosts (que tinha
// virado uma cópia da tela "Usuários & Hosts" do AD, redundante). A ideia
// aqui é outra: mostrar o que cada pessoa TEM DE EQUIPAMENTO agora, na
// prática.
//
// Fonte da verdade é a própria estoque_movimentacoes (Movimentações e
// Entregas foram fundidas numa tabela só, ver prisma/schema.sql) — uma
// linha tipo 'ENTREGA' com devolvido_em NULL é um equipamento que ainda
// está com aquela pessoa; devolvido_em preenchido é um equipamento que já
// voltou (ver POST /estoque/movimentacoes/:id/devolver em
// src/routes/estoque.js, que preenche essa coluna e cria a linha
// 'DEVOLUCAO_COLABORADOR' correspondente no mesmo passo). Não tentamos
// casar isso com registros soltos por nome digitado — o vínculo é sempre
// por ID, decidido no momento da devolução.

function normKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase();
}

// Agrupa as entregas ainda não devolvidas por usuário. Usa o texto de
// "usuario" como veio (não normalizado) pro rótulo, mas agrupa por chave
// normalizada pra "Aline Amorim" e "ALINE AMORIM" caírem juntos.
// A partir de quantos dias com a mesma pessoa um item entra no relatório de
// "parado há muito tempo" (2026-09-17) — sem pedido de valor específico,
// 180 dias (~6 meses) é um ponto de partida razoável pra cobrar devolução/
// regularização; fácil de ajustar se precisar.
const DIAS_EQUIPAMENTO_PARADO = 180;

// Termos de responsabilidade/devolução por pessoa (2026-09-22) — casados
// pelo mesmo campo "usuario" que já liga estoque_colaboradores a
// estoque_movimentacoes (ver comentário em prisma/schema.sql: "bate com
// estoque_entregas.usuario"). Um termo pode cobrir várias entregas de uma
// vez (itens_snapshot), por isso é uma lista por PESSOA, não por item —
// diferente do "termo: true/false" por entrega, que só sinaliza que ALGUM
// termo já cobre aquele item específico.
function buscarTermosPorUsuario(db) {
  const linhas = db
    .prepare(
      `SELECT t.id, t.tipo, t.gerado_em AS geradoEm, t.arquivo, c.usuario AS colaborador_usuario
       FROM estoque_termos t
       JOIN estoque_colaboradores c ON c.id = t.colaborador_id
       WHERE c.usuario IS NOT NULL AND TRIM(c.usuario) != ''
       ORDER BY t.gerado_em DESC`
    )
    .all();

  const porUsuario = new Map();
  for (const t of linhas) {
    const chave = normKey(t.colaborador_usuario);
    if (!porUsuario.has(chave)) porUsuario.set(chave, []);
    porUsuario.get(chave).push({ id: t.id, tipo: t.tipo, geradoEm: t.geradoEm, temArquivo: !!t.arquivo });
  }
  return porUsuario;
}

function calcularEquipamentosPorUsuario(db) {
  const entregas = db
    .prepare(
      `SELECT * FROM estoque_movimentacoes WHERE tipo IN ('ENTREGA', 'EMPRESTIMO') AND devolvido_em IS NULL AND usuario IS NOT NULL AND TRIM(usuario) != '' ORDER BY usuario COLLATE NOCASE, criado_em`
    )
    .all();
  const termosPorUsuario = buscarTermosPorUsuario(db);

  const agora = Date.now();
  const porUsuario = new Map();
  for (const e of entregas) {
    const chave = normKey(e.usuario);
    if (!porUsuario.has(chave)) {
      porUsuario.set(chave, { usuario: e.usuario, host: e.host, departamento: e.departamento, itens: [], termos: termosPorUsuario.get(chave) || [] });
    }
    const grupo = porUsuario.get(chave);
    // Fica com o host/departamento mais recente informado (última entrega) —
    // são só um retrato pra exibição, não uma fonte de verdade própria.
    grupo.host = e.host || grupo.host;
    grupo.departamento = e.departamento || grupo.departamento;
    // Entrega histórica (afeta_saldo = 0, equipamento de termo assinado
    // importado/registrado depois do fato): criado_em é só o dia em que foi
    // lançada na plataforma — a data de verdade é `data` (assinatura do termo).
    const inicio = e.afeta_saldo === 0 && e.data ? new Date(e.data).getTime() : new Date(e.criado_em).getTime();
    const diasComPessoa = Math.floor((agora - inicio) / (24 * 60 * 60 * 1000));
    grupo.itens.push({
      id: e.id,
      equipamento: e.equipamento,
      modelo: e.modelo,
      st: e.st,
      quantidade: e.quantidade,
      termo: !!e.termo,
      criadoEm: e.criado_em,
      diasComPessoa,
      // Empréstimo (home office) é temporário por natureza — não entra no
      // alerta de equipamento parado há meses.
      emprestimo: e.tipo === 'EMPRESTIMO',
      parado: e.tipo !== 'EMPRESTIMO' && diasComPessoa >= DIAS_EQUIPAMENTO_PARADO,
    });
  }

  return [...porUsuario.values()].sort((a, b) => (a.usuario || '').localeCompare(b.usuario || '', 'pt-BR'));
}

module.exports = { calcularEquipamentosPorUsuario, normKey, DIAS_EQUIPAMENTO_PARADO };
