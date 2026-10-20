// Gera o número de protocolo exibido ao solicitante, no formato "AAAA-NNNNNN"
// (ano + sequencial zero-padded, reiniciando a cada ano). O sequencial é
// contado a partir de quantos chamados já existem NAQUELE ano no banco —
// simples e suficiente pro volume de uma equipe pequena; se um dia isso
// precisar suportar múltiplos processos da API escrevendo ao mesmo tempo
// com alta concorrência, vale trocar por uma tabela de contador dedicada
// com transação própria.
function gerarProtocolo(db, dataReferencia = new Date()) {
  const ano = dataReferencia.getFullYear();
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM chamados WHERE protocolo LIKE ?`)
    .get(`${ano}-%`);
  const proximo = total + 1;
  return `${ano}-${String(proximo).padStart(6, '0')}`;
}

module.exports = { gerarProtocolo };
