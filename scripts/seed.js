// Popula dados de referência mínimos pra dar pra usar o sistema (e testar)
// sem precisar cadastrar tudo na mão primeiro. Seguro rodar mais de uma vez
// — cada INSERT só acontece se a linha ainda não existir.
//
// Uso:  npm run seed

require('dotenv').config({ quiet: true });
const { db } = require('../src/lib/db');

function upsertDepartamento(nome) {
  const existente = db.prepare(`SELECT * FROM departamentos WHERE nome = ?`).get(nome);
  if (existente) return existente;
  const info = db.prepare(`INSERT INTO departamentos (nome) VALUES (?)`).run(nome);
  return db.prepare(`SELECT * FROM departamentos WHERE id = ?`).get(info.lastInsertRowid);
}

function upsertCategoria(nome, departamentoId) {
  const existente = db.prepare(`SELECT * FROM categorias WHERE nome = ? AND departamento_id = ?`).get(nome, departamentoId);
  if (existente) return existente;
  const info = db.prepare(`INSERT INTO categorias (nome, departamento_id) VALUES (?, ?)`).run(nome, departamentoId);
  return db.prepare(`SELECT * FROM categorias WHERE id = ?`).get(info.lastInsertRowid);
}

function upsertAtendente(nome, email, departamentoId) {
  const existente = db.prepare(`SELECT * FROM atendentes WHERE email = ?`).get(email);
  if (existente) return existente;
  const info = db.prepare(`INSERT INTO atendentes (nome, email, departamento_id) VALUES (?, ?, ?)`).run(nome, email, departamentoId);
  return db.prepare(`SELECT * FROM atendentes WHERE id = ?`).get(info.lastInsertRowid);
}

function upsertCpdServidor(nome) {
  const existente = db.prepare(`SELECT * FROM cpd_servidores WHERE nome = ?`).get(nome);
  if (existente) return existente;
  const info = db.prepare(`INSERT INTO cpd_servidores (nome) VALUES (?)`).run(nome);
  return db.prepare(`SELECT * FROM cpd_servidores WHERE id = ?`).get(info.lastInsertRowid);
}

function upsertSlaPolitica(departamentoId, categoriaId, prioridade, primeiraRespostaMin, resolucaoMin) {
  const existente = db
    .prepare(`SELECT * FROM sla_politicas WHERE departamento_id = ? AND categoria_id IS ? AND prioridade = ?`)
    .get(departamentoId, categoriaId, prioridade);
  if (existente) return existente;
  const info = db
    .prepare(
      `INSERT INTO sla_politicas (departamento_id, categoria_id, prioridade, prazo_primeira_resposta_minutos, prazo_resolucao_minutos)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(departamentoId, categoriaId, prioridade, primeiraRespostaMin, resolucaoMin);
  return db.prepare(`SELECT * FROM sla_politicas WHERE id = ?`).get(info.lastInsertRowid);
}

const infra = upsertDepartamento('Infraestrutura');
const infraNoturna = upsertDepartamento('Infraestrutura (Central - equipe noturna)');

// Mesmas categorias que já apareciam nos dados reais do TomTicket — ponto de
// partida pra não precisar digitar tudo de novo na mão.
const nomesCategorias = [
  'Acessos e Senhas',
  'Configuração de equipamento',
  'Correção (impedimento do funcionamento/andamento do processo)',
  'Internet e Navegação',
  'Melhoria (otimização de processos já existentes e em andamento)',
  'Mudança de layout',
  'Projetos',
  'Solicitação de equipamento',
];
const categorias = Object.fromEntries(nomesCategorias.map((nome) => [nome, upsertCategoria(nome, infra.id)]));

upsertAtendente('Equipe Infra (padrão)', 'infra@empresa.local', infra.id);

// Política de SLA de exemplo — AJUSTE pros prazos reais que a equipe usa.
// Prioridade "normal": 4h úteis pra primeira resposta, 24h pra resolver.
upsertSlaPolitica(infra.id, null, 'baixa', 8 * 60, 72 * 60);
upsertSlaPolitica(infra.id, null, 'normal', 4 * 60, 24 * 60);
upsertSlaPolitica(infra.id, null, 'alta', 2 * 60, 8 * 60);
upsertSlaPolitica(infra.id, null, 'urgente', 30, 4 * 60);

// Catálogo de servidores do Checklist do CPD — mesma lista do formulário
// Microsoft Forms original.
const nomesServidoresCpd = [
  'SRV-DC-01',
  'SERVERBI2',
  'VMWARE #1',
  'VMWARE #2',
  'VMWARE #3',
  'srv-mas-op',
  'srv-masex-op',
  'srv-radar-op',
  'srv-accs-op',
  'srv-pabx-op',
  'SP01SQLBI01V',
];
const servidoresCpd = nomesServidoresCpd.map(upsertCpdServidor);

console.log('Seed aplicado.');
console.log({ departamentos: [infra, infraNoturna], categorias: Object.keys(categorias), servidoresCpd: servidoresCpd.map((s) => s.nome) });
