#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf '%s\n' 'Użycie: scripts/start-https.sh [--config PLIK --named NAZWA]' 'Bez argumentów uruchamia tymczasowy HTTPS przez TryCloudflare.' 'Stały adres: przygotuj nazwany tunel i wskaż jego konfigurację.'
  exit 0
fi

if [[ -n "${CLOUDFLARED_BIN:-}" ]]; then
  tunnel_bin="$CLOUDFLARED_BIN"
else
  tunnel_bin="$(command -v cloudflared || true)"
fi
if [[ -z "$tunnel_bin" || ! -x "$tunnel_bin" ]]; then
  printf '%s\n' 'Nie znaleziono cloudflared. Zainstaluj: brew install cloudflared' >&2
  exit 1
fi

if [[ $# -gt 0 ]]; then
  if [[ $# -ne 4 || "$1" != "--config" || "$3" != "--named" || ! -f "$2" || -z "$4" ]]; then
    printf '%s\n' 'Dla stałego tunelu podaj: --config /pełna/ścieżka/config.yml --named NAZWA' >&2
    exit 1
  fi
  exec "$tunnel_bin" tunnel --config "$2" run "$4"
fi

gateway_port="${PORT:-8787}"
if [[ ! "$gateway_port" =~ ^[0-9]+$ || "${#gateway_port}" -gt 5 ]]; then
  printf '%s\n' 'PORT musi być liczbą od 1024 do 65535.' >&2
  exit 1
fi
gateway_port=$((10#$gateway_port))
if [[ "$gateway_port" -lt 1024 || "$gateway_port" -gt 65535 ]]; then
  printf '%s\n' 'PORT musi być liczbą od 1024 do 65535.' >&2
  exit 1
fi
printf '%s\n' 'Adres HTTPS pojawi się poniżej w logu cloudflared. Zadziała, gdy bramka i tunel będą uruchomione.' 'To tymczasowy adres testowy; do stałego działania użyj nazwanego tunelu.'
exec "$tunnel_bin" tunnel --url "http://127.0.0.1:$gateway_port"
