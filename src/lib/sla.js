// Resolução de política de SLA e cálculo de prazo.
//
// Regra de resolução (mais específico primeiro): categoria+prioridade >
// departamento (sem categoria)+prioridade > sem política (chamado fica sem
// prazo, mesmo comportamento de "sem SLA definido" que já existia lendo o
// TomTicket).
//
// IMPORTANTE — simplificação assumida por enquanto: o prazo conta em tempo
// corrido (24/7), não só horário comercial. Pra maioria das categorias de
// infraestrutura isso costuma fazer sentido (um servidor caído de
// madrugada continua contando), mas se algum dia vocês quiserem prazo só
// em horário comercial pra alguma categoria, essa é a função a mexer.
function resolverPolitica(db, { departamentoId, categoriaId, prioridade }) {
  const porCategoria = db
    .prepare(
      `SELECT * FROM sla_politicas
       WHERE departamento_id = ? AND categoria_id = ? AND prioridade = ?`
    )
    .get(departamentoId, categoriaId, prioridade);
  if (porCategoria) return porCategoria;

  const porDepartamento = db
    .prepare(
      `SELECT * FROM sla_politicas
       WHERE departamento_id = ? AND categoria_id IS NULL AND prioridade = ?`
    )
    .get(departamentoId, prioridade);
  if (porDepartamento) return porDepartamento;

  return null; // sem política aplicável -> chamado sem prazo de SLA
}

function calcularPrazos(db, { departamentoId, categoriaId, prioridade, criadoEm }) {
  const politica = resolverPolitica(db, { departamentoId, categoriaId, prioridade });
  if (!politica) {
    return { slaPrazoPrimeiraResposta: null, slaPrazoResolucao: null };
  }
  const base = new Date(criadoEm).getTime();
  const primeiraResposta = new Date(base + politica.prazo_primeira_resposta_minutos * 60000).toISOString();
  const resolucao = new Date(base + politica.prazo_resolucao_minutos * 60000).toISOString();
  return { slaPrazoPrimeiraResposta: primeiraResposta, slaPrazoResolucao: resolucao };
}

module.exports = { resolverPolitica, calcularPrazos };
