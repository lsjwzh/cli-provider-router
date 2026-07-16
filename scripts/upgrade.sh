#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Upgrade cli-provider-router from a fixed local source checkout.

Usage:
  upgrade.sh --version VERSION [--source DIR] [--install-root DIR]
             [--bin-dir DIR] [--cpr-home DIR] [--dry-run]

Creates a CPR_HOME backup, installs side-by-side, and keeps the previous
application pointer if installation or health checks fail.
EOF
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
VERSION=""
INSTALL_ROOT="${CPR_INSTALL_ROOT:-$HOME/.local/share/cli-provider-router}"
BIN_DIR="${CPR_BIN_DIR:-$HOME/.local/bin}"
CPR_HOME_VALUE="${CPR_HOME:-$HOME/.cli-provider-router}"
DRY_RUN=0

while (($#)); do
  case "$1" in
    --version) VERSION="${2:?--version requires a value}"; shift 2 ;;
    --source) SOURCE="${2:?--source requires a value}"; shift 2 ;;
    --install-root) INSTALL_ROOT="${2:?--install-root requires a value}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:?--bin-dir requires a value}"; shift 2 ;;
    --cpr-home) CPR_HOME_VALUE="${2:?--cpr-home requires a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$VERSION" ]] || { echo "error: --version is required; refusing a moving/latest upgrade" >&2; exit 2; }
[[ -L "$INSTALL_ROOT/current" || -d "$INSTALL_ROOT/current" ]] || {
  echo "error: no existing source-script installation at $INSTALL_ROOT/current; run install.sh first" >&2
  exit 2
}

if ((DRY_RUN)); then
  exec "$SCRIPT_DIR/install.sh" --source "$SOURCE" --version "$VERSION" \
    --install-root "$INSTALL_ROOT" --bin-dir "$BIN_DIR" --cpr-home "$CPR_HOME_VALUE" --dry-run
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$INSTALL_ROOT/backups/upgrade-$TIMESTAMP"
mkdir -p "$BACKUP_DIR"
chmod 700 "$INSTALL_ROOT/backups" "$BACKUP_DIR" 2>/dev/null || true

OLD_TARGET="$(readlink "$INSTALL_ROOT/current" 2>/dev/null || true)"
if [[ -d "$CPR_HOME_VALUE" ]]; then
  HOME_PARENT="$(cd -- "$CPR_HOME_VALUE/.." && pwd -P)"
  HOME_NAME="$(basename -- "$CPR_HOME_VALUE")"
  tar -czf "$BACKUP_DIR/cpr-home.tar.gz" -C "$HOME_PARENT" "$HOME_NAME"
  chmod 600 "$BACKUP_DIR/cpr-home.tar.gz" 2>/dev/null || true
fi
printf 'previous=%s\ntargetVersion=%s\ncreatedAt=%s\n' "$OLD_TARGET" "$VERSION" "$TIMESTAMP" >"$BACKUP_DIR/upgrade.txt"
chmod 600 "$BACKUP_DIR/upgrade.txt" 2>/dev/null || true

rollback() {
  if [[ -n "$OLD_TARGET" ]]; then
    local tmp="$INSTALL_ROOT/.current.rollback.$$"
    rm -f -- "$tmp"
    ln -s "$OLD_TARGET" "$tmp"
    mv -f -- "$tmp" "$INSTALL_ROOT/current"
    echo "Restored previous application pointer: $OLD_TARGET" >&2
  fi
}

if ! "$SCRIPT_DIR/install.sh" --source "$SOURCE" --version "$VERSION" \
  --install-root "$INSTALL_ROOT" --bin-dir "$BIN_DIR" --cpr-home "$CPR_HOME_VALUE" --force; then
  rollback
  echo "error: upgrade failed; data backup retained at $BACKUP_DIR" >&2
  exit 1
fi

if ! "$BIN_DIR/cpr" --version >/dev/null || ! "$BIN_DIR/cpr" doctor >/dev/null; then
  rollback
  echo "error: post-upgrade health check failed; data backup retained at $BACKUP_DIR" >&2
  exit 1
fi

echo "Upgrade to $VERSION completed"
echo "  backup: $BACKUP_DIR"
echo "  data was preserved at: $CPR_HOME_VALUE"
