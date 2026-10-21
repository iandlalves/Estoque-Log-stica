// Faz uma cópia consistente e completa do banco de dados, mesmo com o
// servidor rodando — inclusive o que só existe no WAL (write-ahead log)
// ainda não "checkpointado" pro arquivo principal. Usa VACUUM INTO do
// próprio SQLite pra isso: é a forma suportada de fazer um backup "a
// quente", sem parar ninguém e sem risco de copiar um arquivo pela metade
// (o que aconteceria copiando o .db com `copy` enquanto ele está em uso).
//
// Também apaga sozinho backups mais antigos que a retenção configurada.
//
// Uso manual:
//   node scripts/backup.js
//   node scripts/backup.js "D:\Backups\CentralInfraestrutura"
//   node scripts/backup.js "D:\Backups\CentralInfraestrutura" 60
//
// Uso agendado: ver scripts/instalar-backup-agendado-windows.ps1 (cria
// uma Tarefa Agendada do Windows que roda isso todo dia).

require('dotenv').config({ quiet: true }); // quiet: evita poluir o log do backup agendado com o banner do dotenv
const path = require('node:path');
const fs = require('node:fs');
const { db } = require('../src/lib/db');

// BACKUP_PREFIXO (2026-10-21): cada instância no mesmo servidor nomeia os
// próprios backups (ex.: "estoque-logistica-"), pra um arquivo nunca ser
// confundido com o da Central — nem apagado pela retenção da outra.
const PREFIXO_ARQUIVO = process.env.BACKUP_PREFIXO || 'central-infraestrutura-';

const BACKUP_DIR = process.argv[2] || process.env.BACKUP_DIR || path.join(__dirname, '..', 'dados', 'backups');
const RETENCAO_DIAS = Number(process.argv[3] || process.env.BACKUP_RETENCAO_DIAS || 30);

if (!Number.isFinite(RETENCAO_DIAS) || RETENCAO_DIAS <= 0) {
  console.error(`Retenção inválida: "${process.argv[3] || process.env.BACKUP_RETENCAO_DIAS}". Use um número de dias maior que zero.`);
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const destino = path.join(BACKUP_DIR, `${PREFIXO_ARQUIVO}${timestamp()}.db`);

try {
  // Aspas simples dentro do literal SQL precisam ser escapadas dobrando —
  // não é injeção de usuário (o caminho vem de configuração do próprio
  // servidor), mas não custa nada fazer certo.
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
} catch (e) {
  console.error('Falha ao gerar o backup:', e.message);
  process.exit(1);
}

const tamanhoMB = (fs.statSync(destino).size / (1024 * 1024)).toFixed(2);
console.log(`Backup criado: ${destino} (${tamanhoMB} MB)`);

// --- Limpeza de backups antigos ------------------------------------------

const agora = Date.now();
const limiteMs = RETENCAO_DIAS * 24 * 60 * 60 * 1000;
let removidos = 0;

for (const nome of fs.readdirSync(BACKUP_DIR)) {
  if (!nome.startsWith(PREFIXO_ARQUIVO) || !nome.endsWith('.db')) continue;
  const caminho = path.join(BACKUP_DIR, nome);
  const stat = fs.statSync(caminho);
  if (agora - stat.mtimeMs > limiteMs) {
    fs.unlinkSync(caminho);
    removidos++;
  }
}

if (removidos > 0) {
  console.log(`Removidos ${removidos} backup(s) com mais de ${RETENCAO_DIAS} dias.`);
}
