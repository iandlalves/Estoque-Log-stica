#!/usr/bin/env bash
# Instala (ou reinstala) UMA instância de Estoque no servidor Linux, ao lado
# da Central de Infraestrutura (2026-10-21). As instâncias (nome, porta,
# endereço, usuário) estão em deploy/instancias.conf — hoje: logistica,
# reversa, dimps, atop. Não precisa de git nem de acesso ao GitHub no
# servidor: o código chega num pacote mandado do Windows.
#
# No Windows (PowerShell, na raiz do projeto):
#   tar -czf "$env:TEMP\estoque.tar.gz" src public prisma scripts deploy package.json package-lock.json README.md DEPLOY-LINUX.md .env.example
#   scp "$env:TEMP\estoque.tar.gz" suporte@192.168.62.194:/tmp/estoque.tar.gz
#
# No servidor:
#   rm -rf /tmp/estoque-src && mkdir -p /tmp/estoque-src && tar -xzf /tmp/estoque.tar.gz -C /tmp/estoque-src
#   bash /tmp/estoque-src/scripts/instalar-instancia-estoque.sh <instância> "email.do.gestor@telehelp.com.br" "Nome do Gestor" ["destinatario@telehelp.com.br"]
#
# O 4º argumento (quem recebe o resumo semanal) é opcional — sem ele, MAIL_TO
# fica vazio no .env e o resumo avisa que falta configurar.
#
# Pode rodar de novo sem estragar nada: não sobrescreve o .env nem o banco
# (dados/) da instância. Ver DEPLOY-LINUX.md, seção 9.
set -euo pipefail

ORIGEM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=instancias.sh
source "$ORIGEM/scripts/instancias.sh"

if [ $# -lt 3 ]; then
  echo "Uso: bash $0 <instância> \"email.do.gestor@...\" \"Nome do Gestor\" [\"destinatario@...\"]"
  echo "Instâncias: $(listar_instancias | tr '\n' ' ')"
  exit 1
fi
carregar_instancia "$1"
GESTOR_EMAIL="$2"
GESTOR_NOME="$3"
MAIL_TO_ESTOQUE="${4:-}"
CENTRAL=/opt/central-infraestrutura

if [ "$ORIGEM" = "$DIR" ]; then
  echo "Rode a partir da pasta extraída do pacote (ex.: /tmp/estoque-src), não de $DIR."
  exit 1
fi

echo "######## $NOME — $URL (porta interna $PORTA) ########"

echo "==> 0. DNS ($NOME_DNS)"
# Sem o registro DNS, o endereço antigo (IP:porta) passaria a redirecionar
# pra um nome que ninguém resolve — a instância ficaria inacessível. Por
# isso para aqui, a menos que SEM_DNS=1 (ex.: instalar antes do DNS sair,
# numa instância que ninguém usa ainda).
RESOLVIDO="$(getent ahostsv4 "$NOME_DNS" 2>/dev/null | awk 'NR==1 {print $1}')"
if [ -z "$RESOLVIDO" ]; then
  if [ "${SEM_DNS:-0}" != "1" ]; then
    echo "ERRO: $NOME_DNS ainda não resolve neste servidor — peça o registro DNS (ver DEPLOY-LINUX.md, seção 9.1)."
    echo "      Pra instalar mesmo assim (instância ainda sem usuários): SEM_DNS=1 bash $0 ..."
    exit 1
  fi
  echo "    AVISO: $NOME_DNS não resolve — seguindo porque SEM_DNS=1."
elif [ "$RESOLVIDO" != "192.168.62.194" ]; then
  echo "    AVISO: $NOME_DNS resolve pra $RESOLVIDO, não pra 192.168.62.194 — confira o registro DNS."
else
  echo "    OK ($RESOLVIDO)."
fi

echo "==> 1. Usuário e pasta ($USUARIO, $DIR)"
id "$USUARIO" >/dev/null 2>&1 || sudo useradd --system --no-create-home --home-dir "$DIR" --shell /usr/sbin/nologin "$USUARIO"
sudo mkdir -p "$DIR"

echo "==> 2. Código (de $ORIGEM — dados/ e .env de $DIR não são tocados)"
sudo cp -a "$ORIGEM/." "$DIR/"
sudo mkdir -p "$DIR/dados" "$DIR/logs"
sudo chown -R "$USUARIO:$USUARIO" "$DIR"

echo "==> 3. Dependências (npm install; se o servidor não alcançar o registro do npm, copia as da Central)"
if ! sudo -u "$USUARIO" timeout 180 bash -c "cd '$DIR' && npm install --omit=dev --no-audit --no-fund --silent"; then
  if cmp -s "$DIR/package-lock.json" "$CENTRAL/package-lock.json"; then
    echo "    npm install falhou — usando node_modules da Central (mesmo package-lock.json)."
    sudo rm -rf "$DIR/node_modules"
    sudo cp -a "$CENTRAL/node_modules" "$DIR/node_modules"
    sudo chown -R "$USUARIO:$USUARIO" "$DIR/node_modules"
  else
    echo "ERRO: npm install falhou e o package-lock.json difere do da Central — instale as dependências à mão."
    exit 1
  fi
fi

echo "==> 4. .env (GRAPH_* e MAIL_FROM copiados do .env da Central)"
if [ ! -f "$DIR/.env" ]; then
  renderizar_modelo "$DIR/deploy/estoque-instancia.env.template" \
    | sed -E '/^(GRAPH_TENANT_ID|GRAPH_CLIENT_ID|GRAPH_CLIENT_SECRET|MAIL_FROM|MAIL_TO)=/d' \
    | sudo -u "$USUARIO" tee "$DIR/.env" >/dev/null
  sudo grep -E '^(GRAPH_TENANT_ID|GRAPH_CLIENT_ID|GRAPH_CLIENT_SECRET|MAIL_FROM)=' "$CENTRAL/.env" | sudo -u "$USUARIO" tee -a "$DIR/.env" >/dev/null
  echo "MAIL_TO=$MAIL_TO_ESTOQUE" | sudo -u "$USUARIO" tee -a "$DIR/.env" >/dev/null
  sudo chmod 600 "$DIR/.env"
else
  echo "    .env já existe — mantido como está."
fi
# .env criado antes do COOKIE_NOME existir (ex.: a 1ª instalação da
# Logística) dividiria o cookie "sessao" com a Central — acrescenta.
if ! sudo grep -q '^COOKIE_NOME=' "$DIR/.env"; then
  echo "COOKIE_NOME=sessao_$SLUG" | sudo -u "$USUARIO" tee -a "$DIR/.env" >/dev/null
  echo "    COOKIE_NOME=sessao_$SLUG acrescentado ao .env."
fi
# APP_BASE_URL segue o nome DNS do instancias.conf (o .env da 1ª instalação
# da Logística ainda tinha o endereço com IP:porta).
if ! sudo grep -qx "APP_BASE_URL=$URL" "$DIR/.env"; then
  sudo sed -i "s|^APP_BASE_URL=.*|APP_BASE_URL=$URL|" "$DIR/.env"
  sudo grep -q '^APP_BASE_URL=' "$DIR/.env" || echo "APP_BASE_URL=$URL" | sudo -u "$USUARIO" tee -a "$DIR/.env" >/dev/null
  echo "    APP_BASE_URL=$URL ajustado no .env."
fi

echo "==> 5. Primeiro gestor"
# Argumentos passados por "$@" (não interpolados no texto do bash -c) — nome
# com apóstrofo não quebra o comando.
sudo -u "$USUARIO" bash -c 'cd "$1" && node scripts/criar-gestor.js "$2" "$3"' _ "$DIR" "$GESTOR_EMAIL" "$GESTOR_NOME"

echo "==> 6. Serviço systemd ($SERVICO)"
renderizar_modelo "$DIR/deploy/estoque-instancia.service.template" | sudo tee "/etc/systemd/system/$SERVICO.service" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICO"
sudo systemctl restart "$SERVICO"
OK=0
for i in $(seq 1 15); do
  sleep 1
  if curl -sf "http://localhost:$PORTA/api/saude" >/dev/null 2>&1; then OK=1; break; fi
done
if [ "$OK" != "1" ]; then
  echo "ERRO: o serviço não respondeu em http://localhost:$PORTA — veja: sudo journalctl -u $SERVICO -n 50 --no-pager"
  exit 1
fi
echo "    $(curl -s "http://localhost:$PORTA/api/config")"

echo "==> 7. Caddy (site em $NOME_DNS + redirecionamento do endereço antigo 192.168.62.194:$PORTA_HTTPS; o da Central não muda)"
renderizar_modelo "$DIR/deploy/Caddyfile.estoque-instancia.template" | sudo tee "/etc/caddy/$SERVICO.caddy" >/dev/null
if ! sudo grep -q "import /etc/caddy/$SERVICO.caddy" /etc/caddy/Caddyfile; then
  sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.antes-$SERVICO-$(date +%Y%m%d-%H%M%S)"
  echo "import /etc/caddy/$SERVICO.caddy" | sudo tee -a /etc/caddy/Caddyfile >/dev/null
fi
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy

echo "==> 8. Firewall (só se o ufw estiver ativo)"
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 443/tcp
  sudo ufw allow "$PORTA_HTTPS/tcp"
else
  echo "    ufw inativo/ausente — nada a fazer."
fi

echo "==> 9. Agendamentos (resumo, lembrete, backup, monitor)"
TMP_CRON="$(mktemp)"
renderizar_modelo "$DIR/deploy/crontab-estoque-instancia.template" > "$TMP_CRON"
chmod 644 "$TMP_CRON"
sudo -u "$USUARIO" crontab "$TMP_CRON"
rm -f "$TMP_CRON"

echo
echo "==> Pronto. Acesse $URL e entre com $GESTOR_EMAIL."
echo "    (Precisa do Redirect URI $URL/api/auth/entra/callback no Azure.)"
if [ -z "$MAIL_TO_ESTOQUE" ] && sudo grep -q '^MAIL_TO=$' "$DIR/.env"; then
  echo "    Falta MAIL_TO em $DIR/.env (quem recebe o resumo semanal) — edite e rode: sudo systemctl restart $SERVICO"
fi
