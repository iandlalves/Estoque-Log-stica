<#
.SINOPSE
  Remove o Serviço do Windows da Central de Infraestrutura (registrado
  por scripts\instalar-servico-windows.ps1). O banco de dados e os
  arquivos do projeto NÃO são apagados — só o serviço.

.USO
  .\scripts\desinstalar-servico-windows.ps1 -NssmPath "C:\ferramentas\nssm.exe"
#>

param(
  [string]$NssmPath = ".\nssm.exe",
  [string]$NomeServico = "CentralInfraestrutura"
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Rode este script num PowerShell aberto como Administrador."
  exit 1
}

if (-not (Test-Path $NssmPath)) {
  Write-Error "Não encontrei o nssm.exe em '$NssmPath'. Informe o caminho certo com -NssmPath."
  exit 1
}

$servico = Get-Service -Name $NomeServico -ErrorAction SilentlyContinue
if (-not $servico) {
  Write-Host "Não existe serviço chamado '$NomeServico' — nada a fazer."
  exit 0
}

Write-Host "Parando e removendo o serviço '$NomeServico'..."
& $NssmPath stop $NomeServico
& $NssmPath remove $NomeServico confirm

Write-Host "Serviço removido. Os arquivos do projeto e o banco de dados (pasta dados\) continuam intactos."
