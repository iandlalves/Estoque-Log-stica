// Cadastra o IP da iDRAC dos servidores do CPD (aba "Atualizações",
// 2026-09-23) a partir da planilha que o usuário mandou — 2ª coluna de IP
// de cada linha é a rede de gerenciamento (confirmado com o usuário: cai
// num bloco fechado 192.168.62.120-127 pra várias das linhas). Servidores
// sem essa informação (N/A, "?", ou vmware1/srv-surgard-dc — combinado
// deixar de fora por enquanto) ficam sem idrac_host, de fora da checagem
// automática até alguém completar pela tela Servidores/Receptoras.
//
// Idempotente — rodar de novo só regrava o mesmo valor.
//
// Uso:
//   node scripts/cadastrar-idrac-cpd.js             (mostra e já grava)
//   node scripts/cadastrar-idrac-cpd.js --so-listar  (só mostra, não grava)

const { db } = require('../src/lib/db');

const soListar = process.argv.includes('--so-listar');

const IPS_IDRAC = {
  'srv-masex-op': '192.168.62.121',
  'srv-mas-op': '192.168.62.122',
  'srv-ad-op': '192.168.62.120',
  'srv-accs-op': '192.168.62.126',
  'srv-pbx-op': '192.168.62.125',
  'srv-radar-op': '192.168.62.127',
  SERVERBI2: '192.168.62.171',
  'srv-storage-op': '192.168.63.124',
  sp01sqlbi01v: '192.168.63.169',
};

console.log('Servidores que vão receber IP da iDRAC:');
for (const [nome, ip] of Object.entries(IPS_IDRAC)) {
  const existente = db.prepare(`SELECT idrac_host FROM cpd_servidores WHERE nome = ? COLLATE NOCASE`).get(nome);
  if (!existente) {
    console.log(`  - ${nome}: NÃO ENCONTRADO no catálogo — pulando.`);
    continue;
  }
  console.log(`  - ${nome}: ${existente.idrac_host || '(vazio)'} -> ${ip}`);
}

console.log('\nSem IP conhecido, ficam de fora da checagem automática por enquanto:');
console.log('  srv-report-op, srv-est-op, srv-nanocomm-op, srv-mqtt-op, vmware1, srv-surgard-dc, srv-fullarm-op, srv-careview-op');

if (soListar) {
  console.log('\n--so-listar: nada foi gravado. Rode sem essa flag pra aplicar de verdade.');
  process.exit(0);
}

const atualizar = db.prepare(`UPDATE cpd_servidores SET idrac_host = ? WHERE nome = ? COLLATE NOCASE`);
let gravados = 0;
for (const [nome, ip] of Object.entries(IPS_IDRAC)) {
  const info = atualizar.run(ip, nome);
  if (info.changes) gravados++;
}

console.log(`\nGravados: ${gravados} de ${Object.keys(IPS_IDRAC).length}.`);
