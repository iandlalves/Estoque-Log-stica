#!/usr/bin/env bash
# Funções compartilhadas pra ler deploy/instancias.conf (2026-10-21) — usado
# por scripts/instalar-instancia-estoque.sh (no servidor) e scripts/deploy.sh
# (no Windows/Git Bash). Só define funções; não faz nada sozinho.

INSTANCIAS_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/instancias.conf"

# Lista os slugs, um por linha.
listar_instancias() {
  grep -vE '^\s*(#|$)' "$INSTANCIAS_CONF" | tr -d '\r' | cut -d'|' -f1
}

# carregar_instancia <slug> — define SLUG, NOME, PORTA, PORTA_HTTPS, USUARIO,
# MIN_BACKUP, NOME_DNS, URL, DIR e SERVICO. Sai com erro se o slug não existir.
carregar_instancia() {
  local linha
  linha="$(grep -vE '^\s*(#|$)' "$INSTANCIAS_CONF" | tr -d '\r' | grep -E "^$1\|" || true)"
  if [ -z "$linha" ]; then
    echo "Instância desconhecida: \"$1\". Válidas: $(listar_instancias | tr '\n' ' ')" >&2
    return 1
  fi
  IFS='|' read -r SLUG NOME PORTA PORTA_HTTPS USUARIO MIN_BACKUP NOME_DNS <<< "$linha"
  if [ -z "$NOME_DNS" ]; then
    echo "Instância \"$1\" sem nome_dns no instancias.conf." >&2
    return 1
  fi
  URL="https://$NOME_DNS"
  DIR="/opt/estoque-$SLUG"
  SERVICO="estoque-$SLUG"
}

# renderizar_modelo <arquivo.template> — imprime o modelo com os @MARCADORES@
# trocados pelos valores da instância carregada.
renderizar_modelo() {
  sed -e "s|@SLUG@|$SLUG|g" -e "s|@NOME@|$NOME|g" -e "s|@PORTA@|$PORTA|g" \
      -e "s|@PORTA_HTTPS@|$PORTA_HTTPS|g" -e "s|@USUARIO@|$USUARIO|g" \
      -e "s|@MIN_BACKUP@|$MIN_BACKUP|g" -e "s|@NOME_DNS@|$NOME_DNS|g" "$1" | tr -d '\r'
}
