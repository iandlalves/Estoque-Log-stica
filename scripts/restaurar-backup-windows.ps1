<#
.SINOPSE
  Restaura o banco de dados da Central de Infraestrutura a partir de um
  backup gerado por scripts\backup.js. Serve tanto pra recuperar de um
  problema quanto pra testar se os backups realmente funcionam — vale a
  pena rodar isso de vez em quando só pra confirmar (backup que nunca foi
  restaurado é um backup em que você não pode confiar de verdade).

.O QUE FAZ
  1. Para o serviço do site, se estiver rodando como Serviço do Windows.
  2. Guarda uma cópia do banco atual, por segurança, antes de sobrescrever.
  3. Copia o backup escolhido pra dados\central-infraestrutura.db, e
     remove os arquivos -wal/-shm antigos (senão o SQLite tenta "juntar"
     eles com o banco novo, que não é o que você quer numa restauração).
  4. Reinicia o serviço.

.USO
  .\scripts\restaurar-backup-windows.ps1 -BackupFile "dados\backups\central-infraestrutura-20260826-020000.db"

  Se o site roda como Serviço do Windows via NSSM, informe -NssmPath pra
  esse script conseguir parar/reiniciar o serviço sozinho. Se você roda
  só com `npm run dev`/`npm start` num PowerShell (sem serviço), pare o
  servidor manualmente (Ctrl+C) ANTES de rodar este script.
#>

param(
  [Parameter(Mandatory = $true)][string]$BackupFile,
  [string]$NssmPath = "",
  [string]$NomeServico = "CentralInfraestrutura"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackupFile)) {
  Write-Error "Não encontrei o arquivo de backup '$BackupFile'."
  exit 1
}

$projetoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dbPath = Join-Path $projetoDir "dados\central-infraestrutura.db"

Write-Host "Isso vai SUBSTITUIR o banco atual ($dbPath) pelo conteúdo de:"
Write-Host "  $BackupFile"
$confirmacao = Read-Host "Digite CONFIRMAR pra continuar"
if ($confirmacao -ne "CONFIRMAR") {
  Write-Host "Cancelado."
  exit 0
}

$servico = Get-Service -Name $NomeServico -ErrorAction SilentlyContinue

if ($servico -and $servico.Status -eq 'Running') {
  Write-Host "Parando o serviço '$NomeServico'..."
  if ($NssmPath -ne "") { & $NssmPath stop $NomeServico } else { Stop-Service -Name $NomeServico }
  Start-Sleep -Seconds 2
} elseif (-not $servico) {
  Write-Host "Não existe serviço '$NomeServico' — confirme que o servidor está PARADO antes de continuar (Ctrl+C se estiver rodando via npm run dev/start)."
  $confirmacaoParado = Read-Host "Servidor está parado? (s/n)"
  if ($confirmacaoParado -ne "s") {
    Write-Host "Pare o servidor primeiro e rode este script de novo."
    exit 0
  }
}

if (Test-Path $dbPath) {
  $copiaSeguranca = "$dbPath.antes-de-restaurar-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $dbPath $copiaSeguranca
  Write-Host "Cópia do banco atual (antes de restaurar) guardada em: $copiaSeguranca"
}

Remove-Item "$dbPath-wal" -ErrorAction SilentlyContinue
Remove-Item "$dbPath-shm" -ErrorAction SilentlyContinue
Copy-Item $BackupFile $dbPath -Force

Write-Host "Banco restaurado a partir de '$BackupFile'."

if ($servico) {
  Write-Host "Reiniciando o serviço '$NomeServico'..."
  if ($NssmPath -ne "") { & $NssmPath start $NomeServico } else { Start-Service -Name $NomeServico }
  Write-Host "Pronto. Confira o site (http://localhost:3000, ou https se já tiver o Caddy)."
} else {
  Write-Host "Suba o servidor de novo manualmente (npm start ou npm run dev)."
}
