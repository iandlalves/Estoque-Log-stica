<#
.SINOPSE
  Agenda um backup diário do banco de dados da Central de Infraestrutura,
  usando o Agendador de Tarefas do próprio Windows — nenhuma ferramenta
  externa pra baixar dessa vez, é tudo nativo.

.O QUE FAZ
  Cria uma Tarefa Agendada que roda `node scripts\backup.js` todo dia no
  horário escolhido, como SYSTEM (não depende de ninguém estar logado).
  O script de backup usa VACUUM INTO do SQLite pra gerar uma cópia
  consistente do banco — funciona com o servidor rodando, sem parar nada
  — e apaga sozinho backups mais velhos que a retenção configurada.

.IMPORTANTE SOBRE ONDE SALVAR
  Por padrão os backups vão pra `dados\backups` dentro do próprio
  projeto — ou seja, no mesmo disco do banco original. Isso protege
  contra o banco corromper, mas NÃO protege contra perda do disco/máquina
  inteira. Se der, use -BackupDir apontando pra outro disco ou um
  compartilhamento de rede (ex: uma pasta no servidor de arquivos que já
  tenha backup próprio).

.REQUISITOS
  PowerShell aberto como Administrador.

.USO
  cd caminho\para\central-infra-app
  .\scripts\instalar-backup-agendado-windows.ps1 -Horario "02:00"

  # salvando em outro disco/rede, com retenção de 60 dias:
  .\scripts\instalar-backup-agendado-windows.ps1 -Horario "02:00" -BackupDir "D:\Backups\CentralInfraestrutura" -RetencaoDias 60
#>

param(
  [string]$Horario = "02:00",
  [string]$BackupDir = "",
  [int]$RetencaoDias = 30,
  [string]$NomeTarefa = "CentralInfraestrutura - Backup diario"
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Rode este script num PowerShell aberto como Administrador."
  exit 1
}

$nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
  Write-Error "Não encontrei o node.exe no PATH. Confirme que o Node.js está instalado (node -v)."
  exit 1
}

$projetoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (Get-ScheduledTask -TaskName $NomeTarefa -ErrorAction SilentlyContinue) {
  Write-Error "Já existe uma tarefa chamada '$NomeTarefa'. Remova primeiro com scripts\desinstalar-backup-agendado-windows.ps1, ou escolha outro nome com -NomeTarefa."
  exit 1
}

if ($BackupDir -ne "") {
  $argumentos = "`"$projetoDir\scripts\backup.js`" `"$BackupDir`" $RetencaoDias"
} else {
  $argumentos = "`"$projetoDir\scripts\backup.js`" `"$(Join-Path $projetoDir 'dados\backups')`" $RetencaoDias"
}

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $argumentos -WorkingDirectory $projetoDir
$trigger = New-ScheduledTaskTrigger -Daily -At $Horario
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principalTarefa = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $NomeTarefa -Action $action -Trigger $trigger -Settings $settings -Principal $principalTarefa `
  -Description "Backup diario do banco da Central de Infraestrutura (VACUUM INTO + retencao automatica de $RetencaoDias dias)." | Out-Null

Write-Host "Tarefa '$NomeTarefa' criada — vai rodar todo dia às $Horario."
if ($BackupDir -ne "") {
  Write-Host "Backups vão pra: $BackupDir"
} else {
  Write-Host "Backups vão pra: $projetoDir\dados\backups (mesmo disco do banco original — considere usar -BackupDir pra outro lugar)"
}
Write-Host "Retenção: $RetencaoDias dias."
Write-Host ""
Write-Host "Pra testar agora sem esperar o horário: Start-ScheduledTask -TaskName `"$NomeTarefa`""
Write-Host "Pra ver o histórico de execuções: abra o Agendador de Tarefas (taskschd.msc) e procure por '$NomeTarefa'."
Write-Host "Pra remover: .\scripts\desinstalar-backup-agendado-windows.ps1"
