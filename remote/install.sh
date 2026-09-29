#!/usr/bin/env bash
set -euo pipefail

RELEASE_BASE='https://github.com/frankpuentemarcas-cuervo/crow-harnes/releases/latest/download'
SERVICE_NAME='crowd.service'
SERVICE_PORT='47321'
install_temp_dir=''
install_staged=''

cleanup() {
  if [[ -n "$install_temp_dir" ]]; then rm -rf -- "$install_temp_dir"; fi
  if [[ -n "$install_staged" ]]; then rm -f -- "$install_staged"; fi
}
trap cleanup EXIT

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
notice() { printf '%s\n' "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "Falta $1 en este servidor."
}

enable_linger() {
  if ! command -v loginctl >/dev/null 2>&1; then
    notice 'Aviso: loginctl no está disponible; crowd podría detenerse al cerrar SSH.'
    return
  fi
  local user linger
  user=$(id -un)
  linger=$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)
  if [[ "$linger" == yes ]]; then return; fi
  if loginctl enable-linger "$user" 2>/dev/null; then return; fi
  if command -v sudo >/dev/null 2>&1 && [[ -r /dev/tty ]]; then
    notice 'Se necesita autorización para mantener crowd activo después de cerrar SSH.'
    if sudo loginctl enable-linger "$user" </dev/tty; then return; fi
  fi
  notice 'Aviso: no se pudo habilitar linger; crowd podría detenerse al cerrar SSH.'
}

session_state() {
  local token_file="$HOME/.local/share/crow-harness/token"
  local payload
  [[ -s "$token_file" ]] && command -v python3 >/dev/null 2>&1 || { printf 'unknown'; return; }
  payload=$(curl -fsS --connect-timeout 3 --max-time 5 \
    -H "Authorization: Bearer $(<"$token_file")" \
    "http://127.0.0.1:$SERVICE_PORT/api/sessions" 2>/dev/null) || { printf 'unknown'; return; }
  printf '%s' "$payload" | python3 -c '
import json
import sys
sessions = json.load(sys.stdin)
if not isinstance(sessions, list):
    raise ValueError("invalid sessions response")
print("active" if any(isinstance(item, dict) and item.get("state") in ("running", "sleeping") for item in sessions) else "idle")
' 2>/dev/null || printf 'unknown'
}

wait_for_health() {
  local token_file="$HOME/.local/share/crow-harness/token"
  local attempt
  for attempt in {1..15}; do
    if [[ -s "$token_file" ]] && curl -fsS --connect-timeout 2 --max-time 2 \
      -H "Authorization: Bearer $(<"$token_file")" \
      "http://127.0.0.1:$SERVICE_PORT/api/health" >/dev/null 2>&1; then
      notice 'crowd está activo y responde en 127.0.0.1:47321.'
      return
    fi
    sleep 1
  done
  fail 'crowd no respondió. Revisá: systemctl --user status crowd.service'
}

main() {
  [[ "$(uname -s)" == Linux ]] || fail 'Este instalador solo funciona en Linux.'
  (( EUID != 0 )) || fail 'Ejecutalo con tu usuario SSH normal, sin sudo.'
  local arch asset binary_dir unit_dir unit state
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail "Arquitectura no compatible: $(uname -m)." ;;
  esac
  for tool in curl sha256sum systemctl install mktemp; do require "$tool"; done
  if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "/run/user/$(id -u)" ]]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi
  enable_linger

  asset="crowd-linux-$arch"
  install_temp_dir=$(mktemp -d)
  notice "Descargando $asset desde GitHub Releases…"
  curl -fsSL --retry 3 --connect-timeout 10 --max-time 180 -o "$install_temp_dir/$asset" "$RELEASE_BASE/$asset"
  curl -fsSL --retry 3 --connect-timeout 10 --max-time 30 -o "$install_temp_dir/$asset.sha256" "$RELEASE_BASE/$asset.sha256"
  (cd "$install_temp_dir" && sha256sum --check --status "$asset.sha256") || fail 'La verificación SHA-256 del binario falló.'

  binary_dir="$HOME/.local/bin"
  unit_dir="$HOME/.config/systemd/user"
  unit="$unit_dir/$SERVICE_NAME"
  mkdir -p "$binary_dir" "$unit_dir"
  install_staged=$(mktemp "$binary_dir/.crowd.XXXXXX")
  install -m 0755 "$install_temp_dir/$asset" "$install_staged"
  mv -f -- "$install_staged" "$binary_dir/crowd"
  install_staged=''

  if [[ ! -e "$unit" ]]; then
    cat >"$unit" <<'SERVICE'
[Unit]
Description=Crow Harness remote runtime
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash -lc 'exec "$HOME/.local/bin/crowd"'
Restart=on-failure
RestartSec=3
Environment=CROW_PORT=47321

[Install]
WantedBy=default.target
SERVICE
  fi
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME" >/dev/null

  if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    state=$(session_state)
    if [[ "$state" != idle ]]; then
      if [[ "$state" == active ]]; then
        notice 'Binario actualizado, pero crowd no se reinició porque hay terminales activas.'
      else
        notice 'Binario actualizado, pero crowd no se reinició porque no se pudo comprobar el estado de las terminales.'
      fi
      notice 'Volvé a ejecutar este mismo comando cuando no haya terminales activas.'
      return
    fi
    systemctl --user restart "$SERVICE_NAME"
  else
    systemctl --user start "$SERVICE_NAME"
  fi
  wait_for_health
  if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
    notice 'Aviso: para usar el navegador remoto también necesitás Chromium/Chrome en este host.'
  fi
}

main "$@"
