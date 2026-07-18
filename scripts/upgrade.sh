#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Upgrade cli-provider-router from a fixed local source checkout.

Usage:
  upgrade.sh --version VERSION [--source DIR] [--install-root DIR]
             [--bin-dir DIR] [--cpr-home DIR] [--expected-sha256 SHA256]
             [--dry-run]

The candidate is installed under an immutable artifact identity before the
active pointer changes. A running service is stopped/restarted under
supervision. Any install, restart or health failure restores the old pointer,
CPR_HOME backup and previous service state.
EOF
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
VERSION=""
INSTALL_ROOT="${CPR_INSTALL_ROOT:-$HOME/.local/share/cli-provider-router}"
BIN_DIR="${CPR_BIN_DIR:-$HOME/.local/bin}"
CPR_HOME_VALUE="${CPR_HOME:-$HOME/.cli-provider-router}"
EXPECTED_SHA256=""
DRY_RUN=0

while (($#)); do
  case "$1" in
    --version) VERSION="${2:?--version requires a value}"; shift 2 ;;
    --source) SOURCE="${2:?--source requires a value}"; shift 2 ;;
    --install-root) INSTALL_ROOT="${2:?--install-root requires a value}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:?--bin-dir requires a value}"; shift 2 ;;
    --cpr-home) CPR_HOME_VALUE="${2:?--cpr-home requires a value}"; shift 2 ;;
    --expected-sha256) EXPECTED_SHA256="${2:?--expected-sha256 requires a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$VERSION" ]] || { echo "error: --version is required; refusing a moving/latest upgrade" >&2; exit 2; }
[[ -L "$INSTALL_ROOT/current" ]] || { echo "error: no existing immutable installation at $INSTALL_ROOT/current; run install.sh first" >&2; exit 2; }
[[ "$CPR_HOME_VALUE" != / && -n "$CPR_HOME_VALUE" ]] || { echo "error: unsafe CPR_HOME" >&2; exit 2; }

INSTALL_ARGS=(--source "$SOURCE" --version "$VERSION" --install-root "$INSTALL_ROOT" --bin-dir "$BIN_DIR" --cpr-home "$CPR_HOME_VALUE")
if [[ -n "$EXPECTED_SHA256" ]]; then INSTALL_ARGS+=(--expected-sha256 "$EXPECTED_SHA256"); fi
if ((DRY_RUN)); then exec "$SCRIPT_DIR/install.sh" "${INSTALL_ARGS[@]}" --dry-run; fi

# Preflight syntax/version/tooling before making a backup or touching service.
"$SCRIPT_DIR/install.sh" "${INSTALL_ARGS[@]}" --dry-run >/dev/null

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$INSTALL_ROOT/backups/upgrade-$TIMESTAMP-$$"
mkdir -p "$BACKUP_DIR"
chmod 700 "$INSTALL_ROOT/backups" "$BACKUP_DIR" 2>/dev/null || true

OLD_TARGET="$(readlink "$INSTALL_ROOT/current")"
OLD_DIR="$(cd -- "$INSTALL_ROOT/current" && pwd -P)"
OLD_BIN="$OLD_DIR/node_modules/.bin/cpr"
[[ -x "$OLD_BIN" ]] || { echo "error: previous cpr executable is missing at $OLD_BIN" >&2; exit 1; }

STATUS_OUTPUT=""
STATUS_CODE=0
STATUS_OUTPUT="$(CPR_HOME="$CPR_HOME_VALUE" "$OLD_BIN" status 2>&1)" || STATUS_CODE=$?
WAS_RUNNING=0
if ((STATUS_CODE == 0)); then WAS_RUNNING=1
elif [[ "$STATUS_OUTPUT" == *unhealthy* ]]; then
  echo "error: existing service is unhealthy; repair or stop it before upgrade" >&2
  exit 1
fi

SERVICE_PORT="$(node -e 'const fs=require("fs"),p=process.argv[1];try{const s=JSON.parse(fs.readFileSync(p));process.stdout.write(String(Number(s.port||s.proxyPort||4567)))}catch(_){process.stdout.write("4567")}' "$CPR_HOME_VALUE/run/service.json")"
SERVICE_WEB_PORT="$(node -e 'const fs=require("fs"),p=process.argv[1],port=Number(process.argv[2]);try{const s=JSON.parse(fs.readFileSync(p));process.stdout.write(String(Number(s.webPort||port+1)))}catch(_){process.stdout.write(String(port+1))}' "$CPR_HOME_VALUE/run/service.json" "$SERVICE_PORT")"

HOME_BACKUP="$BACKUP_DIR/cpr-home.tar.gz"
HOME_EXISTED=0
if [[ -d "$CPR_HOME_VALUE" ]]; then
  HOME_EXISTED=1
  HOME_PARENT="$(cd -- "$CPR_HOME_VALUE/.." && pwd -P)"
  HOME_NAME="$(basename -- "$CPR_HOME_VALUE")"
  tar -czf "$HOME_BACKUP" -C "$HOME_PARENT" "$HOME_NAME"
  chmod 600 "$HOME_BACKUP" 2>/dev/null || true
fi
cp -p -- "$OLD_DIR/release-manifest.json" "$BACKUP_DIR/previous-release-manifest.json" 2>/dev/null || true
printf 'previous=%s\npreviousDir=%s\ntargetVersion=%s\ncreatedAt=%s\nserviceWasRunning=%s\nports=%s,%s\n' \
  "$OLD_TARGET" "$OLD_DIR" "$VERSION" "$TIMESTAMP" "$WAS_RUNNING" "$SERVICE_PORT" "$SERVICE_WEB_PORT" >"$BACKUP_DIR/upgrade.txt"
chmod 600 "$BACKUP_DIR/upgrade.txt" 2>/dev/null || true

RESULT_FILE="$BACKUP_DIR/candidate.json"
CANDIDATE_DIR=""
POINTER_SWITCHED=0
NEW_SERVICE_STARTED=0
OLD_SERVICE_STOPPED=0

restore_pointer() {
  local tmp="$INSTALL_ROOT/.current.rollback.$$"
  rm -f -- "$tmp"
  ln -s "$OLD_TARGET" "$tmp"
  mv -f -- "$tmp" "$INSTALL_ROOT/current"
}

restore_data() {
  if ((HOME_EXISTED)); then
    local parent name
    parent="$(cd -- "$CPR_HOME_VALUE/.." && pwd -P)"
    name="$(basename -- "$CPR_HOME_VALUE")"
    rm -rf -- "$CPR_HOME_VALUE"
    tar -xzf "$HOME_BACKUP" -C "$parent"
    [[ -d "$parent/$name" ]] || return 1
  else
    rm -rf -- "$CPR_HOME_VALUE"
  fi
}

rollback() {
  local original_code="$1"
  local rollback_failed=0
  trap - ERR
  set +e
  if ((NEW_SERVICE_STARTED)); then CPR_LIFECYCLE_OPERATION=upgrade CPR_HOME="$CPR_HOME_VALUE" "$BIN_DIR/cpr" stop >/dev/null 2>&1; fi
  if ((WAS_RUNNING && !OLD_SERVICE_STOPPED)); then
    CPR_LIFECYCLE_OPERATION=upgrade CPR_HOME="$CPR_HOME_VALUE" "$OLD_BIN" stop >/dev/null 2>&1 || rollback_failed=1
    OLD_SERVICE_STOPPED=1
  fi
  if ((POINTER_SWITCHED)); then restore_pointer || rollback_failed=1; fi
  restore_data || rollback_failed=1
  if ((WAS_RUNNING)); then
    CPR_LIFECYCLE_OPERATION=upgrade CPR_HOME="$CPR_HOME_VALUE" CPR_DATA_FILE="$CPR_HOME_VALUE/data/providers.json" \
      "$OLD_BIN" start --port "$SERVICE_PORT" --web-port "$SERVICE_WEB_PORT" >/dev/null 2>&1
    CPR_HOME="$CPR_HOME_VALUE" "$OLD_BIN" status >/dev/null 2>&1
    if (($? != 0)); then rollback_failed=1; fi
  fi
  if ((rollback_failed)); then
    echo "CRITICAL: upgrade failed and rollback was incomplete; backup: $BACKUP_DIR" >&2
  else
    echo "Restored previous artifact, data and service state: $OLD_TARGET" >&2
  fi
  echo "error: upgrade failed; backup retained at $BACKUP_DIR" >&2
  exit "$original_code"
}
trap 'rollback $?' ERR

# Stage and verify the candidate without moving the active pointer.
"$SCRIPT_DIR/install.sh" "${INSTALL_ARGS[@]}" --no-activate --result-file "$RESULT_FILE"
CANDIDATE_DIR="$(node -e 'process.stdout.write(require(process.argv[1]).finalDir)' "$RESULT_FILE")"
[[ -x "$CANDIDATE_DIR/node_modules/.bin/cpr" ]]
CPR_HOME="$CPR_HOME_VALUE" "$CANDIDATE_DIR/node_modules/.bin/cpr" --version | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.exit(s.trim()===process.argv[1]?0:1))' "$VERSION"
CPR_HOME="$CPR_HOME_VALUE" "$CANDIDATE_DIR/node_modules/.bin/cpr" doctor >/dev/null

if ((WAS_RUNNING)); then
  CPR_LIFECYCLE_OPERATION=upgrade CPR_HOME="$CPR_HOME_VALUE" "$OLD_BIN" stop >/dev/null
  OLD_SERVICE_STOPPED=1
fi

NEW_TARGET="versions/$(basename -- "$CANDIDATE_DIR")"
CURRENT_TMP="$INSTALL_ROOT/.current.upgrade.$$"
ln -s "$NEW_TARGET" "$CURRENT_TMP"
mv -f -- "$CURRENT_TMP" "$INSTALL_ROOT/current"
POINTER_SWITCHED=1

[[ "$(CPR_HOME="$CPR_HOME_VALUE" "$BIN_DIR/cpr" --version)" == "$VERSION" ]]
CPR_HOME="$CPR_HOME_VALUE" "$BIN_DIR/cpr" doctor >/dev/null
if ((WAS_RUNNING)); then
  CPR_LIFECYCLE_OPERATION=upgrade CPR_HOME="$CPR_HOME_VALUE" CPR_DATA_FILE="$CPR_HOME_VALUE/data/providers.json" \
    "$BIN_DIR/cpr" start --port "$SERVICE_PORT" --web-port "$SERVICE_WEB_PORT" >/dev/null
  NEW_SERVICE_STARTED=1
  CPR_HOME="$CPR_HOME_VALUE" "$BIN_DIR/cpr" status >/dev/null
fi

# Deterministic fault injection used only by the repository rollback smoke test.
if [[ "${CPR_UPGRADE_TEST_FAIL_AFTER_HEALTH:-0}" == 1 ]]; then
  echo "test hook: failing after candidate health" >&2
  false
fi

trap - ERR
echo "Upgrade to $VERSION completed"
echo "  from:    $OLD_DIR"
echo "  to:      $CANDIDATE_DIR"
echo "  backup:  $BACKUP_DIR"
echo "  service: $([[ "$WAS_RUNNING" == 1 ]] && echo restarted-and-healthy || echo remained-stopped)"
echo "  data:    $CPR_HOME_VALUE"
