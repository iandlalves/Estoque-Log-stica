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
# ESTE REPOSITÓRIO (Estoque-Log-stica, 2026-10-21) atualiza só a instância
# "Estoque Logística" (/opt/estoque-logistica, porta 3001) — a Central de
# Infraestrutura tem repositório próprio e é atualizada por ele. Os padrões
# abaixo já apontam pra instância de Estoque, e o script se recusa a
# mandar este código pra pasta da Central (ver trava logo abaixo).
#
# Variáveis de ambiente opcionais (senão usa os valores de sempre):
#   DEPLOY_HOST, DEPLOY_SSH_USER, DEPLOY_REMOTE_DIR, DEPLOY_SERVICE,
#   DEPLOY_SERVICE_USER, DEPLOY_HEALTH_URL, DEPLOY_BACKUP_BASE
#
# Pede a senha do SSH (e do sudo, no servidor) interativamente, como
# sempre — nada de senha fica guardado em lugar nenhum.
set -euo pipefail

HOST="${DEPLOY_HOST:-192.168.62.194}"
SSH_USER="${DEPLOY_SSH_USER:-suporte}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/estoque-logistica}"
SERVICE="${DEPLOY_SERVICE:-estoque-logistica}"
SERVICE_USER="${DEPLOY_SERVICE_USER:-estoque-log}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://localhost:3001/api/saude}"
BACKUP_BASE="${DEPLOY_BACKUP_BASE:-${REMOTE_DIR}-backups}"

if [ "$REMOTE_DIR" = "/opt/central-infraestrutura" ] || [ "$SERVICE" = "central-infraestrutura" ]; then
  echo "ERRO: este repositório é o da instância de Estoque — não faça deploy dele na Central de Infraestrutura."
  echo "      Atualize a Central pelo repositório Central-de-Infraestrutura."
  exit 1
fi

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
PACOTE_LOCAL="$RAIZ/scripts/.deploy-pacote-$TIMESTAMP.tar.gz"
PACOTE_REMOTO="/tmp/$SERVICE-deploy-$TIMESTAMP.tar.gz"
REMOTO_SCRIPT_LOCAL="$RAIZ/scripts/deploy-remoto.sh"
REMOTO_SCRIPT_REMOTO="/tmp/$SERVICE-deploy-remoto-$TIMESTAMP.sh"

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
  "PACOTE_REMOTO='$PACOTE_REMOTO' TIMESTAMP='$TIMESTAMP' REMOTE_DIR='$REMOTE_DIR' SERVICE='$SERVICE' SERVICE_USER='$SERVICE_USER' HEALTH_URL='$HEALTH_URL' BACKUP_BASE='$BACKUP_BASE' bash '$REMOTO_SCRIPT_REMOTO' && rm -f '$REMOTO_SCRIPT_REMOTO'"

echo "==> Concluído."
