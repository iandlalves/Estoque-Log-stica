<#
.SINOPSE
  Remove a Tarefa Agendada de backup diário (criada por
  scripts\instalar-backup-agendado-windows.ps1). Não apaga nenhum backup
  já feito — só a tarefa que os agenda.

.USO
  .\scripts\desinstalar-backup-agendado-windows.ps1
#>

param(
  [string]$NomeTarefa = "CentralInfraestrutura - Backup diario"
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Rode este script num PowerShell aberto como Administrador."
  exit 1
}

$tarefa = Get-ScheduledTask -TaskName $NomeTarefa -ErrorAction SilentlyContinue
if (-not $tarefa) {
  Write-Host "Não existe tarefa chamada '$NomeTarefa' — nada a fazer."
  exit 0
}

Unregister-ScheduledTask -TaskName $NomeTarefa -Confirm:$false
Write-Host "Tarefa '$NomeTarefa' removida. Os backups já feitos continuam onde estavam."
