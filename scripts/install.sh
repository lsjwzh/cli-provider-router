#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Install cli-provider-router from a fixed local source checkout.

Usage:
  install.sh --version VERSION [--source DIR] [--install-root DIR]
             [--bin-dir DIR] [--cpr-home DIR] [--force] [--dry-run]

The version is mandatory and must match package.json. This script never follows
"latest" and does not download an unverified release.

Environment overrides: CPR_INSTALL_ROOT, CPR_BIN_DIR, CPR_HOME.
EOF
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
VERSION=""
INSTALL_ROOT="${CPR_INSTALL_ROOT:-$HOME/.local/share/cli-provider-router}"
BIN_DIR="${CPR_BIN_DIR:-$HOME/.local/bin}"
CPR_HOME_VALUE="${CPR_HOME:-$HOME/.cli-provider-router}"
FORCE=0
DRY_RUN=0

while (($#)); do
  case "$1" in
    --version) VERSION="${2:?--version requires a value}"; shift 2 ;;
    --source) SOURCE="${2:?--source requires a value}"; shift 2 ;;
    --install-root) INSTALL_ROOT="${2:?--install-root requires a value}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:?--bin-dir requires a value}"; shift 2 ;;
    --cpr-home) CPR_HOME_VALUE="${2:?--cpr-home requires a value}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$VERSION" ]] || { echo "error: --version is required; refusing a moving/latest install" >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]] || { echo "error: unsafe version: $VERSION" >&2; exit 2; }
SOURCE="$(cd -- "$SOURCE" && pwd -P)"
[[ -f "$SOURCE/package.json" ]] || { echo "error: package.json not found under $SOURCE" >&2; exit 2; }

command -v node >/dev/null || { echo "error: Node.js 18+ is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "error: npm is required" >&2; exit 1; }
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
((NODE_MAJOR >= 18)) || { echo "error: Node.js 18+ is required (found $(node --version))" >&2; exit 1; }

PACKAGE_VERSION="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version))' "$SOURCE/package.json")"
[[ "$PACKAGE_VERSION" == "$VERSION" ]] || {
  echo "error: requested version $VERSION does not match package.json version $PACKAGE_VERSION" >&2
  exit 2
}

for required in cli/index.js lib/index.js package-lock.json; do
  [[ -f "$SOURCE/$required" ]] || { echo "error: required source file missing: $required" >&2; exit 2; }
done

while IFS= read -r -d '' file; do
  node --check "$file" >/dev/null
done < <(find "$SOURCE/lib" "$SOURCE/cli" -type f -name '*.js' -print0)

if ((DRY_RUN)); then
  echo "dry-run ok: source=$SOURCE version=$VERSION node=$(node --version)"
  echo "would install to $INSTALL_ROOT/versions/$VERSION and link $BIN_DIR/cpr"
  exit 0
fi

mkdir -p "$INSTALL_ROOT/versions" "$BIN_DIR" "$CPR_HOME_VALUE/data" "$CPR_HOME_VALUE/config" \
  "$CPR_HOME_VALUE/backups" "$CPR_HOME_VALUE/logs" "$CPR_HOME_VALUE/run"
chmod 700 "$CPR_HOME_VALUE" "$CPR_HOME_VALUE/data" "$CPR_HOME_VALUE/config" \
  "$CPR_HOME_VALUE/backups" "$CPR_HOME_VALUE/logs" "$CPR_HOME_VALUE/run" 2>/dev/null || true

FINAL_DIR="$INSTALL_ROOT/versions/$VERSION"
if [[ -e "$FINAL_DIR" && "$FORCE" != 1 ]]; then
  echo "error: $VERSION is already installed at $FINAL_DIR (use --force to rebuild it)" >&2
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cpr-install.XXXXXX")"
STAGE="$INSTALL_ROOT/versions/.${VERSION}.stage.$$"
cleanup() { rm -rf -- "$TMP" "$STAGE"; }
trap cleanup EXIT

echo "Packing fixed source version $VERSION ..."
(cd -- "$SOURCE" && npm pack --ignore-scripts --pack-destination "$TMP" >/dev/null)
TARBALLS=("$TMP"/*.tgz)
[[ ${#TARBALLS[@]} -eq 1 && -f "${TARBALLS[0]}" ]] || { echo "error: npm pack did not produce exactly one archive" >&2; exit 1; }
TARBALL="${TARBALLS[0]}"
if command -v sha256sum >/dev/null; then
  ARCHIVE_SHA256="$(sha256sum "$TARBALL" | awk '{print $1}')"
else
  ARCHIVE_SHA256="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
fi
echo "Package SHA-256: $ARCHIVE_SHA256"

rm -rf -- "$STAGE"
mkdir -p "$STAGE"
npm install --prefix "$STAGE" --no-audit --no-fund --include=optional \
  "$TARBALL" 'express@>=4'

sqlite_runtime_ok() {
  (cd -- "$STAGE" && node -e \
    'const r=require("./node_modules/cli-provider-router/lib/sqlite-runtime").sqliteRuntimeStatus(); process.exit(r.available ? 0 : 1)') \
    >/dev/null 2>&1
}
if ! sqlite_runtime_ok; then
  echo "Rebuilding optional SQLite support for $(node --version) ..." >&2
  npm rebuild --prefix "$STAGE" better-sqlite3 >/dev/null 2>&1 || true
fi
if ! sqlite_runtime_ok; then
  echo "warning: SQLite support is unavailable; CC-Switch features are disabled. Repair with: npm rebuild better-sqlite3" >&2
fi

CPR_BIN="$STAGE/node_modules/.bin/cpr"
[[ -x "$CPR_BIN" ]] || { echo "error: installed cpr executable is missing" >&2; exit 1; }
INSTALLED_VERSION="$(CPR_HOME="$CPR_HOME_VALUE" CPR_DATA_FILE="$CPR_HOME_VALUE/data/providers.json" "$CPR_BIN" --version)"
[[ "$INSTALLED_VERSION" == "$VERSION" ]] || { echo "error: installed version check failed ($INSTALLED_VERSION)" >&2; exit 1; }
CPR_HOME="$CPR_HOME_VALUE" CPR_DATA_FILE="$CPR_HOME_VALUE/data/providers.json" "$CPR_BIN" doctor >/dev/null

if [[ -e "$FINAL_DIR" ]]; then rm -rf -- "$FINAL_DIR"; fi
mv -- "$STAGE" "$FINAL_DIR"

CURRENT_TMP="$INSTALL_ROOT/.current.$$"
rm -f -- "$CURRENT_TMP"
ln -s "versions/$VERSION" "$CURRENT_TMP"
mv -f -- "$CURRENT_TMP" "$INSTALL_ROOT/current"

SHIM="$BIN_DIR/cpr"
SHIM_TMP="$BIN_DIR/.cpr.$$"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -e'
  printf 'DEFAULT_CPR_HOME=%q\n' "$CPR_HOME_VALUE"
  printf 'INSTALL_ROOT=%q\n' "$INSTALL_ROOT"
  printf '%s\n' ': "${CPR_HOME:=$DEFAULT_CPR_HOME}"' 'export CPR_HOME' \
    ': "${CPR_DATA_FILE:=$CPR_HOME/data/providers.json}"' 'export CPR_DATA_FILE' \
    'exec "$INSTALL_ROOT/current/node_modules/.bin/cpr" "$@"'
} >"$SHIM_TMP"
chmod 755 "$SHIM_TMP"
mv -f -- "$SHIM_TMP" "$SHIM"

"$SHIM" --version >/dev/null
"$SHIM" doctor >/dev/null

echo "Installed cli-provider-router $VERSION"
echo "  command: $SHIM"
echo "  app:     $FINAL_DIR"
echo "  data:    $CPR_HOME_VALUE"
echo "  sha256:  $ARCHIVE_SHA256"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  note: add $BIN_DIR to PATH" ;;
esac
