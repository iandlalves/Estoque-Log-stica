#!/usr/bin/env bash
# Deploy da Central de Infraestrutura pro servidor Linux de produção
# (2026-09-17) — antes cada deploy era uma sequência manual de scp por
# arquivo + comandos soltos digitados no servidor; um erro nessa sequência
# já derrubou a produção uma vez (dois arquivos "auth.js" colidindo numa
# pasta flat de scp, indo pro lugar errado). Este script empacota o
# projeto inteiro, manda pro servidor, faz backup do que já está lá,
# aplica, reinicia o serviço e confere /api/saude — se falhar, restaura o
# backup sozinho, sem precisar de intervenção manual.
#
# Uso (Git Bash, na raiz do projeto):
#   bash scripts/deploy.sh
#
# Variáveis de ambiente opcionais (senão usa os valores de sempre):
#   DEPLOY_HOST, DEPLOY_SSH_USER, DEPLOY_REMOTE_DIR, DEPLOY_SERVICE,
#   DEPLOY_SERVICE_USER, DEPLOY_HEALTH_URL
#
# Pede a senha do SSH (e do sudo, no servidor) interativamente, como
# sempre — nada de senha fica guardado em lugar nenhum.
set -euo pipefail

HOST="${DEPLOY_HOST:-192.168.62.194}"
SSH_USER="${DEPLOY_SSH_USER:-suporte}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/central-infraestrutura}"
SERVICE="${DEPLOY_SERVICE:-central-infraestrutura}"
SERVICE_USER="${DEPLOY_SERVICE_USER:-central-infra}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://localhost:3000/api/saude}"

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
PACOTE_LOCAL="$RAIZ/scripts/.deploy-pacote-$TIMESTAMP.tar.gz"
PACOTE_REMOTO="/tmp/central-infra-deploy-$TIMESTAMP.tar.gz"
REMOTO_SCRIPT_LOCAL="$RAIZ/scripts/deploy-remoto.sh"
REMOTO_SCRIPT_REMOTO="/tmp/central-infra-deploy-remoto-$TIMESTAMP.sh"

echo "==> Empacotando o projeto..."
# Lista explícita (não "tudo menos exclusões") de propósito — esta pasta
# raiz não é dedicada só a este app (tem outros scripts/projetos ao lado,
# ex. "06 - SCRIPTS", "Instalador-VPN-Avaya"), então um `tar .` com
# exclusões pegaria e mandaria pro servidor material de outros projetos.
cd "$RAIZ"
tar -czf "$PACOTE_LOCAL" \
  --exclude='scripts/.deploy-pacote-*.tar.gz' \
  src public prisma scripts deploy \
  package.json package-lock.json README.md DEPLOY-LINUX.md .env.example

echo "==> Enviando pro servidor ($HOST)..."
scp "$PACOTE_LOCAL" "$SSH_USER@$HOST:$PACOTE_REMOTO"
scp "$REMOTO_SCRIPT_LOCAL" "$SSH_USER@$HOST:$REMOTO_SCRIPT_REMOTO"
rm -f "$PACOTE_LOCAL"

echo "==> Aplicando no servidor (backup + extrair + reiniciar + health check)..."
ssh -t "$SSH_USER@$HOST" \
  "PACOTE_REMOTO='$PACOTE_REMOTO' TIMESTAMP='$TIMESTAMP' REMOTE_DIR='$REMOTE_DIR' SERVICE='$SERVICE' SERVICE_USER='$SERVICE_USER' HEALTH_URL='$HEALTH_URL' bash '$REMOTO_SCRIPT_REMOTO' && rm -f '$REMOTO_SCRIPT_REMOTO'"

echo "==> Concluído."
