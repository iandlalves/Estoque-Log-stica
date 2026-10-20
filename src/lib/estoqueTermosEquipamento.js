// Liga cada equipamento em mãos de um colaborador aos termos que o cobrem e
// calcula a "Situação" do termo daquele equipamento (2026-10-09).
//
// Um termo cobre um equipamento quando o snapshot do termo (itens_snapshot,
// JSON) tem uma linha que:
//  - aponta o mesmo id da movimentação (termos gerados/enviados pela
//    plataforma); ou
//  - tem a mesma service tag; ou
//  - quando nenhum dos dois tem service tag, o mesmo equipamento + modelo
//    (termos importados de papel antigo, que muitas vezes não têm ST).
//
// Situação (por equipamento em mãos), em ordem de força:
//  'assinado'        — existe termo de responsabilidade assinado (importado ou
//                      enviado) cobrindo o equipamento, ou a entrega foi
//                      registrada já com termo assinado;
//  'gerado'          — só existe termo gerado pela plataforma, ainda sem a
//                      versão assinada;
//  'sem_termo'       — nenhum termo cobre esse equipamento.

const { padronizarServiceTag, chave } = require('./padronizacaoEquipamentos');

const ORIGENS_ASSINADO = new Set(['sharepoint', 'upload']);

function stDe(obj) {
  return padronizarServiceTag(obj && (obj.st || obj.numeroSerie));
}

function equipModeloChave(obj) {
  return `${chave(obj && obj.equipamento)}|${chave(obj && obj.modelo)}`;
}

function lerSnapshot(termo) {
  try {
    const itens = JSON.parse(termo.itens_snapshot || '[]');
    return Array.isArray(itens) ? itens : [];
  } catch (e) {
    return [];
  }
}

function termoCobreItem(snapshot, item) {
  const stItem = stDe(item);
  return snapshot.some((s) => {
    if (s.id && s.id === item.id) return true;
    const stSnap = stDe(s);
    if (stItem && stSnap) return stItem === stSnap;
    if (!stItem && !stSnap) return equipModeloChave(s) === equipModeloChave(item);
    return false;
  });
}

// itens: lista de equipamentos em mãos (calcularEquipamentosPorUsuario).
// Devolve a mesma lista com `termos` (os que cobrem o item, mais recente
// primeiro) e `situacaoTermo`.
function anexarTermosAosItens(db, colaboradorId, itens) {
  const termos = db
    .prepare(`SELECT id, tipo, origem, arquivo, data_assinatura, gerado_em, itens_snapshot FROM estoque_termos WHERE colaborador_id = ? ORDER BY COALESCE(data_assinatura, gerado_em) DESC`)
    .all(colaboradorId)
    .map((t) => ({ ...t, snapshot: lerSnapshot(t) }));

  return itens.map((item) => {
    const cobrem = termos.filter((t) => termoCobreItem(t.snapshot, item));
    const responsabilidades = cobrem.filter((t) => t.tipo !== 'devolucao');
    // A marca `termo` da movimentação também é ligada quando a plataforma
    // gera um termo (ainda não assinado), por isso um termo gerado que cobre
    // o item vem ANTES dessa marca; a marca sozinha (sem termo ligado)
    // significa "entrega registrada já com termo assinado".
    let situacaoTermo = 'sem_termo';
    if (responsabilidades.some((t) => ORIGENS_ASSINADO.has(t.origem))) situacaoTermo = 'assinado';
    else if (responsabilidades.some((t) => t.origem === 'gerado')) situacaoTermo = 'gerado';
    else if (item.termo) situacaoTermo = 'assinado';
    return {
      ...item,
      situacaoTermo,
      termos: cobrem.map((t) => ({
        id: t.id,
        tipo: t.tipo,
        origem: t.origem,
        data: t.data_assinatura || t.gerado_em,
        temArquivo: !!t.arquivo,
      })),
    };
  });
}

module.exports = { anexarTermosAosItens, termoCobreItem };
