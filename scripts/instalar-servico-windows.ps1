<#
.SINOPSE
  Registra a Central de Infraestrutura como Serviço do Windows, usando o
  NSSM (Non-Sucking Service Manager) — assim ela continua rodando depois
  de reiniciar a máquina, sem precisar de ninguém logado nem de um
  PowerShell aberto com `npm run dev`.

.IMPORTANTE
  Este script NÃO baixa o NSSM sozinho. Baixar e rodar um executável de
  terceiros automaticamente, sem revisão, não é uma boa prática — baixe
  você mesmo, é rápido:

    1. Acesse https://nssm.cc/download e baixe o .zip da versão estável.
    2. Extraia o .zip. Dentro da pasta `win64` tem o `nssm.exe`.
    3. Copie esse `nssm.exe` pra algum lugar fixo (ex: C:\ferramentas\nssm.exe)
       ou pra dentro da pasta deste projeto.

.REQUISITOS
  - PowerShell aberto como Administrador (registrar serviço exige isso).
  - Node.js já instalado (`node -v` funcionando).
  - `npm install` já rodado nesta pasta pelo menos uma vez.

.USO
  cd caminho\para\central-infra-app
  .\scripts\instalar-servico-windows.ps1 -NssmPath "C:\ferramentas\nssm.exe"

  Parâmetros opcionais: -NomeServico (padrão "CentralInfraestrutura"),
  -Porta (padrão 3000).
#>

param(
  [string]$NssmPath = ".\nssm.exe",
  [string]$NomeServico = "CentralInfraestrutura",
  [int]$Porta = 3000
)

$ErrorActionPreference = "Stop"

# --- Checagens ---------------------------------------------------------

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Rode este script num PowerShell aberto como Administrador (botão direito -> Executar como administrador)."
  exit 1
}

if (-not (Test-Path $NssmPath)) {
  Write-Error "Não encontrei o nssm.exe em '$NssmPath'. Baixe em https://nssm.cc/download (ver instruções no topo deste arquivo) e informe o caminho certo com -NssmPath."
  exit 1
}

$nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
  Write-Error "Não encontrei o node.exe no PATH. Confirme que o Node.js está instalado (rode 'node -v' num PowerShell novo)."
  exit 1
}

$projetoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not (Test-Path (Join-Path $projetoDir "node_modules"))) {
  Write-Error "Não encontrei 'node_modules' em '$projetoDir'. Rode 'npm install' nessa pasta antes de instalar o serviço."
  exit 1
}

$servicoExistente = Get-Service -Name $NomeServico -ErrorAction SilentlyContinue
if ($servicoExistente) {
  Write-Error "Já existe um serviço chamado '$NomeServico'. Remova primeiro com scripts\desinstalar-servico-windows.ps1, ou use -NomeServico pra escolher outro nome."
  exit 1
}

# --- Instalação ----------------------------------------------------------

$logsDir = Join-Path $projetoDir "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

Write-Host "Instalando serviço '$NomeServico'..."
& $NssmPath install $NomeServico $nodePath "src\server.js"
& $NssmPath set $NomeServico AppDirectory $projetoDir
& $NssmPath set $NomeServico AppEnvironmentExtra "PORT=$Porta"
& $NssmPath set $NomeServico AppStdout (Join-Path $logsDir "servidor.log")
& $NssmPath set $NomeServico AppStderr (Join-Path $logsDir "servidor-erro.log")
& $NssmPath set $NomeServico AppRotateFiles 1
& $NssmPath set $NomeServico AppRotateBytes 10485760
& $NssmPath set $NomeServico Start SERVICE_AUTO_START
& $NssmPath set $NomeServico DisplayName "Central de Infraestrutura"
& $NssmPath set $NomeServico Description "Service desk proprio de Infraestrutura (motor de chamados, SLA, avaliacoes) - sem vinculo com TomTicket."

Write-Host "Iniciando o serviço..."
& $NssmPath start $NomeServico
Start-Sleep -Seconds 2

$status = (Get-Service -Name $NomeServico).Status
Write-Host ""
Write-Host "Serviço '$NomeServico' instalado. Status: $status"
Write-Host "Site em: http://localhost:$Porta"
Write-Host "Logs em: $logsDir"
Write-Host ""
Write-Host "Comandos úteis:"
Write-Host "  Ver status:  Get-Service $NomeServico"
Write-Host "  Parar:       nssm stop $NomeServico"
Write-Host "  Reiniciar:   nssm restart $NomeServico"
Write-Host "  Remover:     .\scripts\desinstalar-servico-windows.ps1 -NssmPath `"$NssmPath`""
