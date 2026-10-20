<#
.SINOPSE
  Registra o Caddy (reverse proxy com HTTPS) como Serviço do Windows,
  usando o mesmo NSSM já usado pro serviço da Central de Infraestrutura.
  Faz o Caddy apontar pro Caddyfile em deploy\Caddyfile.

.IMPORTANTE
  Este script NÃO baixa o Caddy nem o NSSM sozinho — baixe você mesmo:

    1. Caddy: https://caddyserver.com/download (escolha Windows/amd64,
       sem plugins extras é suficiente) → baixe o `caddy.exe` e copie pra
       um lugar fixo, ex: C:\ferramentas\caddy.exe
    2. NSSM: se ainda não tiver (já devia ter baixado pro serviço da
       Central de Infraestrutura), https://nssm.cc/download.

  Antes de rodar isso, edite `deploy\Caddyfile` — troque
  "central-infra.empresa.local" pelo nome que sua equipe vai usar (ver
  README, seção "HTTPS com Caddy"), e ajuste o caminho do log se quiser.

.REQUISITOS
  - PowerShell aberto como Administrador.
  - Portas 80 e 443 livres nesta máquina (nada mais ocupando elas).

.USO
  cd caminho\para\central-infra-app
  .\scripts\instalar-caddy-servico-windows.ps1 `
      -CaddyPath "C:\ferramentas\caddy.exe" `
      -NssmPath "C:\ferramentas\nssm.exe"
#>

param(
  [Parameter(Mandatory = $true)][string]$CaddyPath,
  [string]$NssmPath = ".\nssm.exe",
  [string]$NomeServico = "CentralInfraestruturaCaddy"
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Rode este script num PowerShell aberto como Administrador."
  exit 1
}

if (-not (Test-Path $CaddyPath)) {
  Write-Error "Não encontrei o caddy.exe em '$CaddyPath'. Baixe em https://caddyserver.com/download e informe o caminho certo com -CaddyPath."
  exit 1
}

if (-not (Test-Path $NssmPath)) {
  Write-Error "Não encontrei o nssm.exe em '$NssmPath'. Baixe em https://nssm.cc/download e informe o caminho certo com -NssmPath."
  exit 1
}

$projetoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$caddyfilePath = Join-Path $projetoDir "deploy\Caddyfile"
if (-not (Test-Path $caddyfilePath)) {
  Write-Error "Não encontrei '$caddyfilePath'. Confirme que está rodando este script de dentro da pasta do projeto."
  exit 1
}

$servicoExistente = Get-Service -Name $NomeServico -ErrorAction SilentlyContinue
if ($servicoExistente) {
  Write-Error "Já existe um serviço chamado '$NomeServico'. Remova primeiro (nssm remove $NomeServico confirm) se quiser reinstalar."
  exit 1
}

$logsDir = Join-Path $projetoDir "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

Write-Host "Instalando serviço '$NomeServico'..."
& $NssmPath install $NomeServico $CaddyPath "run --config `"$caddyfilePath`" --adapter caddyfile"
& $NssmPath set $NomeServico AppDirectory $projetoDir
& $NssmPath set $NomeServico AppStdout (Join-Path $logsDir "caddy.log")
& $NssmPath set $NomeServico AppStderr (Join-Path $logsDir "caddy-erro.log")
& $NssmPath set $NomeServico AppRotateFiles 1
& $NssmPath set $NomeServico AppRotateBytes 10485760
& $NssmPath set $NomeServico Start SERVICE_AUTO_START
& $NssmPath set $NomeServico DisplayName "Central de Infraestrutura - Caddy (HTTPS)"
& $NssmPath set $NomeServico Description "Reverse proxy HTTPS (Caddy) na frente do site da Central de Infraestrutura."

Write-Host "Iniciando o serviço..."
& $NssmPath start $NomeServico
Start-Sleep -Seconds 2

$status = (Get-Service -Name $NomeServico).Status
Write-Host ""
Write-Host "Serviço '$NomeServico' instalado. Status: $status"
Write-Host "Logs em: $logsDir"
Write-Host ""
Write-Host "Próximo passo: acesse https://<nome que você configurou no Caddyfile> e confirme"
Write-Host "que o site abre com cadeado. Só DEPOIS disso, defina COOKIE_SECURE=true no .env"
Write-Host "e reinicie o serviço da Central de Infraestrutura (nssm restart CentralInfraestrutura)."
