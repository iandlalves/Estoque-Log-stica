// Importa o estoque-dados.json exportado pela ferramenta antiga
// (Central-de-Infraestrutura.html / Controle-de-Estoque.html) pras tabelas
// novas (estoque_itens, estoque_usados, estoque_movimentacoes,
// estoque_entregas, estoque_consultores, estoque_corporativos). Roda uma
// vez só, na migração — depois disso o
// estoque passa a viver só neste banco, gerenciado pela tela do site.
//
// Idempotente: usa INSERT OR REPLACE por id, então rodar de novo (ex.: pra
// reimportar depois de mais alguma edição feita na ferramenta antiga antes
// de desligar ela de vez) não duplica nada — só atualiza.
//
// Uso:
//   node scripts/importar-estoque.js "C:\caminho\para\estoque-dados.json"

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { db } = require('../src/lib/db');

const caminho = process.argv[2];
if (!caminho) {
  console.error('Uso: node scripts/importar-estoque.js "<caminho para estoque-dados.json>"');
  process.exit(1);
}

let bruto;
try {
  bruto = fs.readFileSync(caminho, 'utf-8');
} catch (e) {
  console.error(`Não consegui ler "${caminho}": ${e.message}`);
  process.exit(1);
}
const semBom = bruto.charCodeAt(0) === 0xfeff ? bruto.slice(1) : bruto;

let dados;
try {
  dados = JSON.parse(semBom);
} catch (e) {
  console.error(`Arquivo não é um JSON válido: ${e.message}`);
  process.exit(1);
}

function importar(nomeTabela, lista, mapear) {
  if (!Array.isArray(lista)) {
    console.log(`  (nada em "${nomeTabela}" — chave não encontrada ou não é uma lista)`);
    return 0;
  }
  const stmt = mapear.sql;
  const prepared = db.prepare(stmt);
  let n = 0;
  for (const item of lista) {
    if (!item.id) continue; // registro sem id não dá pra importar de forma idempotente
    prepared.run(...mapear.valores(item));
    n++;
  }
  console.log(`  ${nomeTabela}: ${n} registro(s) importado(s)/atualizado(s).`);
  return n;
}

console.log(`Importando de "${caminho}"...`);

importar('itens', dados.itens, {
  sql: `INSERT INTO estoque_itens (id, item, minimo, status_manual, auto) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET item=excluded.item, minimo=excluded.minimo, status_manual=excluded.status_manual, auto=excluded.auto`,
  valores: (i) => [i.id, i.item || '', Number(i.minimo) || 0, i.statusManual || null, i.auto ? 1 : 0],
});

importar('usados', dados.usados, {
  sql: `INSERT INTO estoque_usados (id, item, quantidade, estado, detalhes) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET item=excluded.item, quantidade=excluded.quantidade, estado=excluded.estado, detalhes=excluded.detalhes`,
  valores: (i) => [i.id, i.item || '', Number(i.quantidade) || 0, i.estado || null, i.detalhes || null],
});

importar('movimentacoes', dados.movimentacoes, {
  sql: `INSERT INTO estoque_movimentacoes (id, data, tipo, descricao, equipamento, quantidade) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data, tipo=excluded.tipo, descricao=excluded.descricao, equipamento=excluded.equipamento, quantidade=excluded.quantidade`,
  valores: (m) => [m.id, m.data || '', m.tipo || '', m.descricao || null, m.equipamento || '', Number(m.quantidade) || 0],
});

importar('entregas', dados.entregas, {
  sql: `INSERT INTO estoque_entregas (id, usuario, host, departamento, equipamento, st, quantidade, termo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET usuario=excluded.usuario, host=excluded.host, departamento=excluded.departamento, equipamento=excluded.equipamento, st=excluded.st, quantidade=excluded.quantidade, termo=excluded.termo`,
  valores: (e) => [e.id, e.usuario || null, e.host || null, e.departamento || null, e.equipamento || '', e.st || null, Number(e.quantidade) || 1, e.termo ? 1 : 0],
});

// "hosts" (mapa manual usuário → host/departamento) parou de ser importado
// de propósito — a aba Hosts foi substituída pelos dados ao vivo do AD, e
// depois por "Equipamentos por usuário" (ver prisma/schema.sql e
// src/routes/estoque.js); a tabela estoque_hosts ficou pra trás, sem uso.

importar('consultores', dados.consultores, {
  sql: `INSERT INTO estoque_consultores (id, usuario, departamento, numero_celular, numero_tablet, gmail, imei, iccid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET usuario=excluded.usuario, departamento=excluded.departamento, numero_celular=excluded.numero_celular, numero_tablet=excluded.numero_tablet, gmail=excluded.gmail, imei=excluded.imei, iccid=excluded.iccid`,
  valores: (c) => [c.id, c.usuario || null, c.departamento || null, c.numeroCelular || null, c.numeroTablet || null, c.gmail || null, c.imei || null, c.iccid || null],
});

importar('corporativos', dados.corporativos, {
  sql: `INSERT INTO estoque_corporativos (id, item, departamento, numero, st, gmail, imei) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET item=excluded.item, departamento=excluded.departamento, numero=excluded.numero, st=excluded.st, gmail=excluded.gmail, imei=excluded.imei`,
  valores: (c) => [c.id, c.item || '', c.departamento || null, c.numero || null, c.st || null, c.gmail || null, c.imei || null],
});

console.log('Importação concluída.');
