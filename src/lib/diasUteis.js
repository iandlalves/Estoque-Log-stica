// Funções pequenas de calendário usadas pelos envios automáticos de email
// do estoque (scripts/enviar-resumo-estoque.js e scripts/enviar-lembrete-
// estoque.js) e pelo checklist do CPD (scripts/enviar-lembrete-cpd.js,
// src/routes/cpd.js).
//
// Feriado (2026-09-08): passou a ser levado em conta em "dia útil"
// (ehDiaUtil) — antes só olhava fim de semana, e um feriado em dia de
// semana virava "falta" incorreta no painel do CPD. A lista de feriados
// vem do cadastro em Cadastros (tabela `feriados`, mantida pelo Gestor,
// ver src/routes/referencia.js) — carregarFeriados(db) busca ela; quem
// chama ehDiaUtil decide se passa esse conjunto ou não (funções deste
// arquivo continuam puras, sem depender de banco sozinhas).

// 'AAAA-MM-DD' a partir do calendário LOCAL (não UTC) — mesma data que a
// pessoa vê no relógio da máquina que roda o cron, e que bate com o
// data_registro salvo pelo checklist do CPD.
function formatarDataLocal(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function carregarFeriados(db) {
  return new Set(db.prepare(`SELECT data FROM feriados`).all().map((f) => f.data));
}

function ehSextaFeira(data) {
  return data.getDay() === 5; // 0 = domingo ... 5 = sexta ... 6 = sábado
}

// Segunda a sexta e fora do calendário de feriados — usado pelo lembrete do
// checklist do CPD (meta é "todo dia útil", não só sexta) e pelo painel de
// "dias faltantes" (src/routes/cpd.js). `feriados` é opcional (Set de
// 'AAAA-MM-DD', ver carregarFeriados) — sem ele, continua só fim de semana,
// mesmo comportamento de antes.
function ehDiaUtil(data, feriados = new Set()) {
  const dia = data.getDay();
  if (dia === 0 || dia === 6) return false;
  return !feriados.has(formatarDataLocal(data));
}

// Último dia do mês que não é sábado/domingo — ex.: se o mês termina num
// sábado, o "fim útil" é a sexta anterior; se termina num domingo, é a
// sexta anterior (dois dias antes). Não considera feriado de propósito
// (recuar mais um dia por causa de feriado no fim do mês não foi pedido —
// só o caso de "falta" do CPD que motivou a mudança acima).
function ehUltimoDiaUtilDoMes(data) {
  const ultimoDiaCalendario = new Date(data.getFullYear(), data.getMonth() + 1, 0);
  const diaSemana = ultimoDiaCalendario.getDay();
  const recuo = diaSemana === 0 ? 2 : diaSemana === 6 ? 1 : 0; // domingo recua 2, sábado recua 1
  ultimoDiaCalendario.setDate(ultimoDiaCalendario.getDate() - recuo);
  return (
    data.getFullYear() === ultimoDiaCalendario.getFullYear() &&
    data.getMonth() === ultimoDiaCalendario.getMonth() &&
    data.getDate() === ultimoDiaCalendario.getDate()
  );
}

module.exports = { ehSextaFeira, ehUltimoDiaUtilDoMes, ehDiaUtil, carregarFeriados, formatarDataLocal };
