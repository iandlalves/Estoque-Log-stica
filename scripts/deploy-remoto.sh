#!/usr/bin/env bash
# Executado NO SERVIDOR por scripts/deploy.sh (nunca rodar isso direto,
# a menos que $PACOTE_REMOTO já exista lá, ver deploy.sh) — 2026-09-17.
#
# Faz, nessa ordem: backup do código atual (sem dados/ nem .env) → extrai
# o pacote novo por cima → npm install → ajusta dono dos arquivos →
# reinicia o serviço → confere /api/saude. Se a checagem falhar, restaura
# o backup sozinho e devolve o serviço ao estado anterior.
set -euo pipefail

: "${PACOTE_REMOTO:?defina PACOTE_REMOTO}"
: "${TIMESTAMP:?defina TIMESTAMP}"
: "${REMOTE_DIR:?defina REMOTE_DIR}"
: "${SERVICE:?defina SERVICE}"
: "${SERVICE_USER:?defina SERVICE_USER}"
: "${HEALTH_URL:?defina HEALTH_URL}"

BACKUP_DIR="/opt/central-infraestrutura-backups/$TIMESTAMP"

echo "==> Backup do código atual em $BACKUP_DIR..."
sudo mkdir -p "$BACKUP_DIR"
sudo tar -cf - -C "$REMOTE_DIR" --exclude='node_modules' --exclude='dados' --exclude='.env' . \
  | sudo tar -xf - -C "$BACKUP_DIR"

echo "==> Extraindo pacote novo por cima (preserva dados/ e .env, que nem estão no pacote)..."
sudo tar -xzf "$PACOTE_REMOTO" -C "$REMOTE_DIR"
rm -f "$PACOTE_REMOTO"

echo "==> Instalando dependências (rápido se package.json não mudou; até 30s, não trava o deploy se o servidor não tiver acesso ao registro do npm)..."
if ! sudo -u "$SERVICE_USER" timeout 30 bash -c "cd '$REMOTE_DIR' && npm install --omit=dev --silent"; then
  echo "==> Aviso: npm install não terminou a tempo (ou falhou) — seguindo com o node_modules que já existe. Se alguma dependência nova foi adicionada, instale manualmente depois."
fi

echo "==> Ajustando dono dos arquivos..."
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$REMOTE_DIR"

echo "==> Reiniciando o serviço..."
sudo systemctl restart "$SERVICE"

echo "==> Aguardando o serviço responder em $HEALTH_URL..."
OK=0
for i in $(seq 1 15); do
  sleep 1
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    OK=1
    break
  fi
done

if [ "$OK" = "1" ]; then
  echo "==> Deploy OK — serviço respondendo."
  # Mantém só os 5 backups mais recentes, pra não acumular disco.
  if [ -d /opt/central-infraestrutura-backups ]; then
    (cd /opt/central-infraestrutura-backups && ls -1t | tail -n +6 | xargs -r sudo rm -rf)
  fi
else
  echo "==> FALHOU — /api/saude não respondeu depois do restart. Restaurando backup anterior..."
  sudo tar -cf - -C "$BACKUP_DIR" . | sudo tar -xf - -C "$REMOTE_DIR"
  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$REMOTE_DIR"
  sudo systemctl restart "$SERVICE"
  echo "==> Backup restaurado e serviço reiniciado com a versão anterior."
  echo "==> Investigue com: sudo journalctl -u $SERVICE -n 80 --no-pager"
  exit 1
fi
