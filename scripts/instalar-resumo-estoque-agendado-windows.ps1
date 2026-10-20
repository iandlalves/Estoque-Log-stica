<#
.SINOPSE
  Agenda o envio do resumo de estoque por email, usando o Agendador de
  Tarefas do próprio Windows (nada externo pra baixar).

.O QUE FAZ
  Cria uma Tarefa Agendada que roda `node scripts\enviar-resumo-estoque.js`
  TODO DIA, no horário escolhido, como SYSTEM (não depende de ninguém
  logado). É diária (não semanal) de propósito: o pedido é enviar toda
  sexta-feira E todo fim útil de mês, e o Agendador do Windows não tem um
  gatilho nativo de "último dia útil do mês" — então quem decide se hoje é
  dia de enviar é o próprio script (ver src/lib/diasUteis.js); nos outros
  dias ele roda e não faz nada.

  Requer o App Registration do Entra ID configurado no .env
  (GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET/MAIL_FROM — ver
  README, seção "Email do estoque") — sem isso o script falha com uma
  mensagem clara (fica registrado no histórico da tarefa, mas ninguém
  recebe email). Destinatários (rodrigo.orsoni + suporte em cópia) já vêm
  com um padrão no próprio script; pra trocar sem editar código, defina
  RESUMO_ESTOQUE_TO / RESUMO_ESTOQUE_CC no .env.

.REQUISITOS
  PowerShell aberto como Administrador.

.USO
  cd caminho\para\central-infra-app
  .\scripts\instalar-resumo-estoque-agendado-windows.ps1
  .\scripts\instalar-resumo-estoque-agendado-windows.ps1 -Horario "17:00"
#>

param(
  [string]$Horario = "17:00",
  [string]$NomeTarefa = "CentralInfraestrutura - Resumo semanal de estoque"
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

$argumentos = "`"$projetoDir\scripts\enviar-resumo-estoque.js`""

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $argumentos -WorkingDirectory $projetoDir
$trigger = New-ScheduledTaskTrigger -Daily -At $Horario
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principalTarefa = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $NomeTarefa -Action $action -Trigger $trigger -Settings $settings -Principal $principalTarefa `
  -Description "Envia por email o resumo de estoque (itens precisando comprar e totais) toda sexta-feira e todo fim útil de mês. Roda todo dia às $Horario; o script decide se é dia de enviar." | Out-Null

Write-Host "Tarefa '$NomeTarefa' criada — vai rodar TODO DIA às $Horario (só envia de fato toda sexta-feira e no último dia útil do mês)."
Write-Host ""
Write-Host "Pra testar agora sem esperar o horário: Start-ScheduledTask -TaskName `"$NomeTarefa`""
Write-Host "Pra ver o histórico de execuções: abra o Agendador de Tarefas (taskschd.msc) e procure por '$NomeTarefa'."
Write-Host "Pra remover: .\scripts\desinstalar-resumo-estoque-agendado-windows.ps1 -NomeTarefa '$NomeTarefa'"
