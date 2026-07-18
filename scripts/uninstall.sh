#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Uninstall cli-provider-router application files.

Usage:
  uninstall.sh [--install-root DIR] [--bin-dir DIR] [--cpr-home DIR] [--purge]

Data under CPR_HOME is preserved unless --purge is supplied. Uninstall is
refused while CPR's integration state reports an active CC-Switch takeover or
while CPR directly manages a native Claude/Codex configuration. Restore the
affected configuration explicitly before uninstalling; this script never
rewrites user CLI configuration automatically.
EOF
}

INSTALL_ROOT="${CPR_INSTALL_ROOT:-$HOME/.local/share/cli-provider-router}"
BIN_DIR="${CPR_BIN_DIR:-$HOME/.local/bin}"
CPR_HOME_VALUE="${CPR_HOME:-$HOME/.cli-provider-router}"
PURGE=0

while (($#)); do
  case "$1" in
    --install-root) INSTALL_ROOT="${2:?--install-root requires a value}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:?--bin-dir requires a value}"; shift 2 ;;
    --cpr-home) CPR_HOME_VALUE="${2:?--cpr-home requires a value}"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "error: Node.js is required to validate takeover state before uninstall" >&2; exit 1; }

STATE_FILES=("$CPR_HOME_VALUE/ccswitch/state.json")
for state_file in "${STATE_FILES[@]}"; do
  [[ -e "$state_file" ]] || continue
  if ! node - "$state_file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
let state;
try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (error) {
  console.error(`error: cannot validate integration state ${file}: ${error.message}`);
  process.exit(2);
}
const phase = String(state.status || '').toLowerCase();
const inactive = ['inactive', 'restored', 'full-restored'].includes(phase);
// Unknown or missing phases fail closed when a state file exists.
const active = !inactive;
if (active) {
  console.error(`error: CC-Switch takeover is active according to ${file}`);
  console.error('Restore CC-Switch endpoints before uninstalling cli-provider-router.');
  process.exit(3);
}
NODE
  then
    exit 3
  fi
done

DIRECT_STATE_DIR="$CPR_HOME_VALUE/direct-cli-config/state"
if [[ -d "$DIRECT_STATE_DIR" ]]; then
  for state_file in "$DIRECT_STATE_DIR"/*.json; do
    [[ -e "$state_file" ]] || continue
    if ! node - "$state_file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
let state;
try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (error) {
  console.error(`error: cannot validate direct CLI takeover state ${file}: ${error.message}`);
  process.exit(2);
}
const valid = state && typeof state === 'object' && !Array.isArray(state);
const phase = valid ? String(state.status || '').toLowerCase() : '';
// Direct takeover currently removes its state after restore. If a state file
// exists, only an explicit inactive/restored marker may allow uninstall;
// unknown/partial formats fail closed.
const inactive = valid && (state.active === false || ['inactive', 'restored', 'full-restored'].includes(phase));
const active = !inactive;
if (active) {
  const cli = state.cli || 'native CLI';
  console.error(`error: direct ${cli} configuration takeover is active according to ${file}`);
  console.error(`Run cpr cli-config restore --cli ${cli} --yes before uninstalling cli-provider-router.`);
  console.error('CPR will not restore or delete native CLI configuration automatically.');
  process.exit(3);
}
NODE
    then
      exit 3
    fi
  done
fi

SHIM="$BIN_DIR/cpr"
if [[ -L "$SHIM" ]]; then
  target="$(readlink "$SHIM" 2>/dev/null || true)"
  case "$target" in *cli-provider-router*|*"$INSTALL_ROOT"*) rm -f -- "$SHIM" ;; esac
elif [[ -f "$SHIM" ]]; then
  content="$(<"$SHIM")"
  case "$content" in *"$INSTALL_ROOT"*) rm -f -- "$SHIM" ;; esac
fi

rm -rf -- "$INSTALL_ROOT"
echo "Removed cli-provider-router application files from $INSTALL_ROOT"

if ((PURGE)); then
  rm -rf -- "$CPR_HOME_VALUE"
  echo "Purged CPR data from $CPR_HOME_VALUE"
else
  echo "Preserved CPR data at $CPR_HOME_VALUE"
  echo "Run again with --purge only when you intentionally want to delete it."
fi
