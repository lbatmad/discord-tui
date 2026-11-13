#!/usr/bin/env bash
# Instala zcord (Discord en tu terminal):
#   curl -fsSL https://zcord.gonzalorocca.com/install.sh | bash
# Descarga el código en ~/.local/share/zcord (o lo actualiza), instala Bun si falta y deja el comando `zcord`
# en ~/.local/bin. Correrlo de nuevo actualiza. Para desinstalar: rm -rf ~/.local/share/zcord ~/.local/bin/zcord
set -euo pipefail

REPO="${ZCORD_REPO:-https://github.com/gonzalonicolasr/discord-tui.git}"
DIR="${ZCORD_DIR:-$HOME/.local/share/zcord}"
BIN="${ZCORD_BIN:-$HOME/.local/bin}"

say() { printf '\033[33m›\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

SYSTEM="$(uname -s)"
# macOS no trae pw-cat ni wl-copy: las integraciones con el escritorio cambian de binarios por plataforma
# (ver src/proc/platform.ts). En Mac el chat funciona; la pantalla compartida todavía no.
case "$SYSTEM" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=darwin ;;
  *) fail "zcord por ahora corre solo en Linux y macOS (detectado: $SYSTEM)." ;;
esac
command -v git >/dev/null 2>&1 || fail "falta git (instalalo con tu gestor de paquetes)."

if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  elif [ -x /opt/homebrew/bin/bun ]; then
    # Homebrew en Apple Silicon: bun está instalado pero puede no estar en el PATH de este shell.
    export PATH="/opt/homebrew/bin:$PATH"
  else
    command -v curl >/dev/null 2>&1 || fail "falta curl para instalar Bun."
    say "instalando Bun (bun.sh)…"
    curl -fsSL https://bun.sh/install | bash >/dev/null
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi

if [ -d "$DIR/.git" ]; then
  say "actualizando zcord en $DIR…"
  git -C "$DIR" pull --ff-only --quiet
else
  say "descargando zcord en $DIR…"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi

say "instalando dependencias (puede tardar un minuto la primera vez)…"
# El lockfile del repo lo escribió un Bun más nuevo (lockfileVersion 2). Un Bun viejo lo rechaza y aborta con
# "Unknown lockfile version", así que se reintenta sin --frozen-lockfile: las versiones de package.json son
# exactas, así que el resultado es el mismo. Con un Bun al día queda el camino rápido y estricto.
if ! (cd "$DIR" && bun install --frozen-lockfile >/dev/null 2>&1); then
  say "el install estricto (--frozen-lockfile) falló; reintento sin él (las versiones de package.json son exactas)…"
  (cd "$DIR" && bun install >/dev/null) || fail "no se pudieron instalar las dependencias."
fi

mkdir -p "$BIN"
ln -sf "$DIR/bin/zcord" "$BIN/zcord"

missing=()
if [ "$PLATFORM" = linux ]; then
  command -v pw-cat >/dev/null 2>&1 || missing+=("pipewire (voz)")
  command -v wl-copy >/dev/null 2>&1 || missing+=("wl-clipboard (pegar y copiar)")
  command -v ffmpeg >/dev/null 2>&1 || command -v wf-recorder >/dev/null 2>&1 || missing+=("ffmpeg o wf-recorder (compartir pantalla)")
else
  # pngpaste permite pegar capturas del portapapeles; ffmpeg reproduce el audio en macOS.
  command -v ffmpeg >/dev/null 2>&1 || missing+=("ffmpeg (reproducción de audio)")
  command -v pngpaste >/dev/null 2>&1 || missing+=("pngpaste (pegar capturas: brew install pngpaste)")
fi

echo
printf '\033[32m✓\033[0m zcord instalado.\n'
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "  Ojo: $BIN no está en tu PATH. Agregalo o corré $BIN/zcord." ;;
esac
[ ${#missing[@]} -eq 0 ] || echo "  Opcional, para todo: ${missing[*]}."
echo
echo "  zcord        la primera vez muestra un QR: escanealo con la app de Discord del celular"
echo "               (tu perfil → ⚙ Configuración → Escanear código QR) y listo."
echo "  zcord demo   para mirar la interfaz con datos de prueba, sin loguearte."
echo
if [ "$PLATFORM" = darwin ]; then
  echo "  En macOS el chat funciona; la captura de voz usa el helper nativo y la reproducción usa ffmpeg."
  echo "  Pantalla compartida (Go Live) todavía no está portada."
  echo "  Usa una terminal con protocolo gráfico (Ghostty, kitty o iTerm2) para ver imágenes y GIFs."
else
  echo "  Usa una terminal con protocolo Kitty (Ghostty o Kitty)."
fi
echo "  Entra con tu cuenta personal: eso va contra los Términos de Discord, así que es bajo tu riesgo."
