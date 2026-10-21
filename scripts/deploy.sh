#!/usr/bin/env bash
# Deploy pro servidor Linux de produção (2026-09-17) — antes cada deploy era
# uma sequência manual de scp por arquivo + comandos soltos digitados no
# servidor; um erro nessa sequência já derrubou a produção uma vez (dois
# arquivos "auth.js" colidindo numa pasta flat de scp, indo pro lugar
# errado). Este script empacota o projeto inteiro, manda pro servidor, faz
# backup do que já está lá, aplica, reinicia o serviço e confere
# /api/saude — se falhar, restaura o backup sozinho, sem precisar de
# intervenção manual.
#
# ESTE REPOSITÓRIO (Estoque-Log-stica, 2026-10-21) atualiza só as instâncias
# de Estoque listadas em deploy/instancias.conf (logistica, reversa, dimps,
# atop) — a Central de Infraestrutura tem repositório próprio e é atualizada
# por ele. Uma instância precisa ter sido instalada antes (ver
# scripts/instalar-instancia-estoque.sh e DEPLOY-LINUX.md, seção 9).
#
# Uso (Git Bash, na raiz do projeto):
#   bash scripts/deploy.sh reversa          # uma instância
#   bash scripts/deploy.sh dimps atop       # várias
#   bash scripts/deploy.sh todas            # todas as do instancias.conf
#
# Um pacote e uma conexão SSH só, mesmo atualizando várias — pede a senha
# do SSH (e do sudo) uma vez. Cada instância é aplicada e conferida em
# separado: se uma falhar, ela volta à versão anterior e as seguintes não
# são atualizadas.
#
# Variáveis de ambiente opcionais: DEPLOY_HOST, DEPLOY_SSH_USER.
set -euo pipefail

HOST="${DEPLOY_HOST:-192.168.62.194}"
SSH_USER="${DEPLOY_SSH_USER:-suporte}"

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=instancias.sh
source "$RAIZ/scripts/instancias.sh"

if [ $# -eq 0 ]; then
  echo "Uso: bash scripts/deploy.sh <instância...> | todas"
  echo "Instâncias: $(listar_instancias | tr '\n' ' ')"
  exit 1
fi
if [ "$1" = "todas" ]; then
  mapfile -t ALVOS < <(listar_instancias)
else
  ALVOS=("$@")
fi
for alvo in "${ALVOS[@]}"; do carregar_instancia "$alvo" >/dev/null; done # valida antes de empacotar

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
PACOTE_LOCAL="$RAIZ/scripts/.deploy-pacote-$TIMESTAMP.tar.gz"
PACOTE_REMOTO="/tmp/estoque-deploy-$TIMESTAMP.tar.gz"
REMOTO_SCRIPT_LOCAL="$RAIZ/scripts/deploy-remoto.sh"
REMOTO_SCRIPT_REMOTO="/tmp/estoque-deploy-remoto-$TIMESTAMP.sh"

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

# Monta um comando remoto que aplica o mesmo pacote em cada instância, em
# sequência (MANTER_PACOTE=1 até a última, que apaga o pacote no fim).
COMANDO="set -e"
TOTAL=${#ALVOS[@]}
N=0
for alvo in "${ALVOS[@]}"; do
  carregar_instancia "$alvo"
  N=$((N + 1))
  MANTER=1
  [ "$N" -eq "$TOTAL" ] && MANTER=0
  COMANDO+="; echo; echo '######## $NOME ($SERVICO) ########'"
  COMANDO+="; PACOTE_REMOTO='$PACOTE_REMOTO' TIMESTAMP='$TIMESTAMP' REMOTE_DIR='$DIR' SERVICE='$SERVICO' SERVICE_USER='$USUARIO' HEALTH_URL='http://localhost:$PORTA/api/saude' BACKUP_BASE='$DIR-backups' MANTER_PACOTE='$MANTER' bash '$REMOTO_SCRIPT_REMOTO'"
done
COMANDO+="; rm -f '$REMOTO_SCRIPT_REMOTO' '$PACOTE_REMOTO'"

echo "==> Aplicando no servidor (backup + extrair + reiniciar + health check): ${ALVOS[*]}"
ssh -t "$SSH_USER@$HOST" "$COMANDO"

echo "==> Concluído."
