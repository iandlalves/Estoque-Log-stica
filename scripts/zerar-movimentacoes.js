// Zera o histórico da aba Movimentações (apaga TODAS as linhas — entrada,
// saída, entrega, devolução) sem alterar a quantidade em estoque de nenhum
// item: antes de apagar, calcula o saldo atual de cada item (mesma lógica
// de src/lib/estoqueResumo.js) e, pros itens com saldo diferente de zero,
// recria uma única linha ("saldo inicial") com esse saldo — ENTRADA se o
// saldo é positivo, SAÍDA se for negativo (não deveria acontecer, mas cobre
// o caso). Assim o histórico fica limpo/vazio pra reorganizar a plataforma,
// mas o cálculo de saldo dá exatamente o mesmo resultado de antes.
//
// Pedido explícito (2026-08-31): plataforma é nova, não precisa do
// histórico de movimentações acumulado até aqui, mas a quantidade em
// estoque (aba Itens) não pode mudar. Confirmado também: zera TUDO,
// inclusive entregas ainda em aberto — "Equipamentos por usuário" fica
// vazio e só volta a preencher com as entregas registradas dali pra frente.
//
// Uso:
//   node scripts/zerar-movimentacoes.js              (banco de produção)
//   node scripts/zerar-movimentacoes.js "caminho.db" (teste numa cópia)
//
// Roda tudo dentro de uma transação: se o saldo recalculado depois não bater
// exatamente com o de antes, item a item, desfaz tudo e não muda nada.

const crypto = require('node:crypto');

const caminhoDb = process.argv[2];
if (caminhoDb) process.env.DATABASE_PATH = caminhoDb;

const { db } = require('../src/lib/db');
const { calcularItensComSaldo, normKey } = require('../src/lib/estoqueResumo');

const antes = calcularItensComSaldo(db);
const saldoAntesPorChave = new Map(antes.map((i) => [normKey(i.item), i.saldo]));
const totalMovAntes = db.prepare('SELECT COUNT(*) AS n FROM estoque_movimentacoes').get().n;

const hoje = new Date().toISOString().slice(0, 10);
const inserirSaldoInicial = db.prepare(
  `INSERT INTO estoque_movimentacoes (id, data, tipo, descricao, equipamento, quantidade)
   VALUES (?, ?, ?, ?, ?, ?)`
);

db.exec('BEGIN');
try {
  db.exec('DELETE FROM estoque_movimentacoes');

  let reconciliados = 0;
  for (const item of antes) {
    if (item.saldo === 0) continue;
    const tipo = item.saldo > 0 ? 'ENTRADA' : 'SAIDA';
    inserirSaldoInicial.run(
      crypto.randomUUID(),
      hoje,
      tipo,
      `Saldo inicial (reset do histórico de movimentações em ${hoje})`,
      item.item,
      Math.abs(item.saldo)
    );
    reconciliados += 1;
  }

  const depois = calcularItensComSaldo(db);
  const divergencias = depois.filter((i) => (saldoAntesPorChave.get(normKey(i.item)) || 0) !== i.saldo);
  if (divergencias.length) {
    throw new Error(
      'Saldo mudou: ' +
        divergencias
          .map((i) => `${i.item} (era ${saldoAntesPorChave.get(normKey(i.item))}, ficou ${i.saldo})`)
          .join('; ')
    );
  }

  db.exec('COMMIT');
  console.log(
    `OK — ${totalMovAntes} movimentação(ões) apagada(s), ${reconciliados} linha(s) de "saldo inicial" recriada(s) pra preservar a quantidade em estoque. Saldo conferido em todos os ${antes.length} itens: sem nenhuma mudança.`
  );
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Abortado — nada foi alterado no banco:', e.message);
  process.exit(1);
}
