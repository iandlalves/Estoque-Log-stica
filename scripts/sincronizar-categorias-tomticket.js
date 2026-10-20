// Sincroniza a tabela `categorias` (departamento "Infraestrutura", id=1)
// com a lista atual do TomTicket — pedido explícito (2026-09-02): a lista
// daqui tinha ficado desatualizada (2 categorias que não existem mais no
// TomTicket, 4 que existem lá e faltavam aqui).
//
// Remove: "Correção (impedimento do funcionamento/andamento do processo)",
//         "Melhoria (otimização de processos já existentes e em andamento)"
// Adiciona: "Admissão", "Envio de computador para Home Office",
//           "Sistemas e Programas", "Telefonia"
//
// Seguro de rodar de novo (idempotente): só adiciona o que ainda não
// existe, só remove o que ainda existe. Antes de remover uma categoria,
// confere se algum chamado ou política de SLA já usa ela — se usar, NÃO
// remove (evita deixar referência quebrada) e avisa quais chamados são.
//
// Uso: node scripts/sincronizar-categorias-tomticket.js

const { db } = require('../src/lib/db');

const DEPARTAMENTO_INFRAESTRUTURA_ID = 1;
const REMOVER = [
  'Correção (impedimento do funcionamento/andamento do processo)',
  'Melhoria (otimização de processos já existentes e em andamento)',
];
const ADICIONAR = ['Admissão', 'Envio de computador para Home Office', 'Sistemas e Programas', 'Telefonia'];

const buscarPorNome = db.prepare(`SELECT * FROM categorias WHERE nome = ? AND departamento_id = ?`);
const contarChamados = db.prepare(`SELECT COUNT(*) AS n FROM chamados WHERE categoria_id = ?`);
const contarSla = db.prepare(`SELECT COUNT(*) AS n FROM sla_politicas WHERE categoria_id = ?`);
const listarChamados = db.prepare(`SELECT protocolo FROM chamados WHERE categoria_id = ?`);
const remover = db.prepare(`DELETE FROM categorias WHERE id = ?`);
const inserir = db.prepare(`INSERT INTO categorias (nome, departamento_id) VALUES (?, ?)`);

console.log('--- Removendo categorias que não existem mais no TomTicket ---');
for (const nome of REMOVER) {
  const cat = buscarPorNome.get(nome, DEPARTAMENTO_INFRAESTRUTURA_ID);
  if (!cat) {
    console.log(`(já não existe: "${nome}")`);
    continue;
  }
  const emUso = contarChamados.get(cat.id).n + contarSla.get(cat.id).n;
  if (emUso > 0) {
    const protocolos = listarChamados.all(cat.id).map((c) => c.protocolo);
    console.log(`NÃO removida (id ${cat.id}, "${nome}") — em uso: ${protocolos.length} chamado(s) [${protocolos.join(', ')}] e/ou política de SLA vinculada.`);
    continue;
  }
  remover.run(cat.id);
  console.log(`Removida: id ${cat.id} — "${nome}"`);
}

console.log('\n--- Adicionando categorias novas do TomTicket ---');
for (const nome of ADICIONAR) {
  const existente = buscarPorNome.get(nome, DEPARTAMENTO_INFRAESTRUTURA_ID);
  if (existente) {
    console.log(`(já existe: id ${existente.id} — "${nome}")`);
    continue;
  }
  const info = inserir.run(nome, DEPARTAMENTO_INFRAESTRUTURA_ID);
  console.log(`Adicionada: id ${info.lastInsertRowid} — "${nome}"`);
}

console.log('\n--- Lista final de categorias (Infraestrutura) ---');
console.log(db.prepare(`SELECT id, nome FROM categorias WHERE departamento_id = ? ORDER BY id`).all(DEPARTAMENTO_INFRAESTRUTURA_ID));
