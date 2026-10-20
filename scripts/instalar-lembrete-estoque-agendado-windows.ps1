<#
.SINOPSE
  Agenda o lembrete matinal de "bater o estoque", usando o Agendador de
  Tarefas do próprio Windows.

.O QUE FAZ
  Cria uma Tarefa Agendada que roda `node scripts\enviar-lembrete-estoque.js`
  TODO DIA de manhã, no horário escolhido, como SYSTEM. É diária de
  propósito (mesma razão do resumo — ver
  scripts\instalar-resumo-estoque-agendado-windows.ps1): quem decide se hoje
  é sexta-feira é o próprio script; nos outros dias ele roda e não faz nada.

  Email só pra quem faz a contagem física (ian.alves + lauan.silva por
  padrão — pra trocar sem editar código, defina LEMBRETE_ESTOQUE_TO no
  .env, separado por vírgula). Requer o mesmo App Registration do resumo
  (GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET/MAIL_FROM no .env).

.REQUISITOS
  PowerShell aberto como Administrador.

.USO
  cd caminho\para\central-infra-app
  .\scripts\instalar-lembrete-estoque-agendado-windows.ps1
  .\scripts\instalar-lembrete-estoque-agendado-windows.ps1 -Horario "08:00"
#>

param(
  [string]$Horario = "08:00",
  [string]$NomeTarefa = "CentralInfraestrutura - Lembrete de bater o estoque"
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

if (-not (Test-Path (Join-Path $projetoDir ".env"))) {
  Write-Warning "Não encontrei um .env em '$projetoDir' — confirme que GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET/MAIL_FROM estão configurados antes do envio automático rodar (ver README, seção 'Email do estoque')."
}

if (Get-ScheduledTask -TaskName $NomeTarefa -ErrorAction SilentlyContinue) {
  Write-Error "Já existe uma tarefa chamada '$NomeTarefa'. Remova primeiro com scripts\desinstalar-resumo-estoque-agendado-windows.ps1 -NomeTarefa '$NomeTarefa', ou escolha outro nome com -NomeTarefa."
  exit 1
}

$argumentos = "`"$projetoDir\scripts\enviar-lembrete-estoque.js`""

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $argumentos -WorkingDirectory $projetoDir
$trigger = New-ScheduledTaskTrigger -Daily -At $Horario
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principalTarefa = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $NomeTarefa -Action $action -Trigger $trigger -Settings $settings -Principal $principalTarefa `
  -Description "Lembrete por email pra bater o estoque toda sexta-feira de manhã. Roda todo dia às $Horario; o script decide se é sexta-feira." | Out-Null

Write-Host "Tarefa '$NomeTarefa' criada — vai rodar TODO DIA às $Horario (só envia de fato às sextas-feiras)."
Write-Host ""
Write-Host "Pra testar agora sem esperar o horário: Start-ScheduledTask -TaskName `"$NomeTarefa`""
Write-Host "Pra ver o histórico de execuções: abra o Agendador de Tarefas (taskschd.msc) e procure por '$NomeTarefa'."
Write-Host "Pra remover: .\scripts\desinstalar-resumo-estoque-agendado-windows.ps1 -NomeTarefa '$NomeTarefa'"
