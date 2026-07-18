#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Install cli-provider-router from a fixed local source checkout.

Usage:
  install.sh --version VERSION [--source DIR] [--install-root DIR]
             [--bin-dir DIR] [--cpr-home DIR] [--expected-sha256 SHA256]
             [--no-activate] [--result-file FILE] [--dry-run]

Every package is installed under an immutable version+commit+tar-SHA identity.
An existing artifact is verified and reused, never overwritten in place.
The version is mandatory and must match package.json. No moving/latest source is
downloaded. Environment overrides: CPR_INSTALL_ROOT, CPR_BIN_DIR, CPR_HOME.
EOF
}

sha256_file() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
VERSION=""
INSTALL_ROOT="${CPR_INSTALL_ROOT:-$HOME/.local/share/cli-provider-router}"
BIN_DIR="${CPR_BIN_DIR:-$HOME/.local/bin}"
CPR_HOME_VALUE="${CPR_HOME:-$HOME/.cli-provider-router}"
EXPECTED_SHA256=""
RESULT_FILE=""
ACTIVATE=1
DRY_RUN=0

while (($#)); do
  case "$1" in
    --version) VERSION="${2:?--version requires a value}"; shift 2 ;;
    --source) SOURCE="${2:?--source requires a value}"; shift 2 ;;
    --install-root) INSTALL_ROOT="${2:?--install-root requires a value}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:?--bin-dir requires a value}"; shift 2 ;;
    --cpr-home) CPR_HOME_VALUE="${2:?--cpr-home requires a value}"; shift 2 ;;
    --expected-sha256) EXPECTED_SHA256="${2:?--expected-sha256 requires a value}"; shift 2 ;;
    --result-file) RESULT_FILE="${2:?--result-file requires a value}"; shift 2 ;;
    --no-activate) ACTIVATE=0; shift ;;
    --force) echo "warning: --force is deprecated; immutable artifacts are verified/reused and never overwritten" >&2; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$VERSION" ]] || { echo "error: --version is required; refusing a moving/latest install" >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]] || { echo "error: unsafe version: $VERSION" >&2; exit 2; }
[[ -z "$EXPECTED_SHA256" || "$EXPECTED_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "error: --expected-sha256 must be 64 hexadecimal characters" >&2; exit 2; }
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

for required in cli/index.js lib/index.js lib/api-metadata.js package-lock.json types/index.d.ts; do
  [[ -f "$SOURCE/$required" ]] || { echo "error: required source file missing: $required" >&2; exit 2; }
done

while IFS= read -r -d '' file; do node --check "$file" >/dev/null; done \
  < <(find "$SOURCE/lib" "$SOURCE/cli" "$SOURCE/scripts" -type f -name '*.js' -print0)

SOURCE_COMMIT="${CPR_SOURCE_COMMIT:-}"
if [[ -z "$SOURCE_COMMIT" ]] && command -v git >/dev/null; then
  SOURCE_COMMIT="$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)"
fi
[[ "$SOURCE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || SOURCE_COMMIT="unknown"
SOURCE_DIRTY=false
if [[ "$SOURCE_COMMIT" != unknown ]] && [[ -n "$(git -C "$SOURCE" status --porcelain 2>/dev/null || true)" ]]; then SOURCE_DIRTY=true; fi
LOCK_SHA256="$(sha256_file "$SOURCE/package-lock.json")"
NODE_ABI="$(node -p 'process.versions.modules')"

if ((DRY_RUN)); then
  echo "dry-run ok: source=$SOURCE version=$VERSION commit=$SOURCE_COMMIT node=$(node --version) ABI=$NODE_ABI"
  echo "would pack, verify, and install under $INSTALL_ROOT/versions/<version>-<commit>-<tar-sha>"
  exit 0
fi

mkdir -p "$INSTALL_ROOT/versions" "$INSTALL_ROOT/artifacts" "$BIN_DIR" \
  "$CPR_HOME_VALUE/data" "$CPR_HOME_VALUE/config" "$CPR_HOME_VALUE/backups" \
  "$CPR_HOME_VALUE/logs" "$CPR_HOME_VALUE/run"
chmod 700 "$INSTALL_ROOT/artifacts" "$CPR_HOME_VALUE" "$CPR_HOME_VALUE/data" \
  "$CPR_HOME_VALUE/config" "$CPR_HOME_VALUE/backups" "$CPR_HOME_VALUE/logs" \
  "$CPR_HOME_VALUE/run" 2>/dev/null || true

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cpr-install.XXXXXX")"
STAGE=""
cleanup() { rm -rf -- "$TMP"; [[ -z "$STAGE" ]] || rm -rf -- "$STAGE"; }
trap cleanup EXIT

echo "Packing fixed source version $VERSION ..."
(cd -- "$SOURCE" && npm pack --ignore-scripts --pack-destination "$TMP" >/dev/null)
TARBALLS=("$TMP"/*.tgz)
[[ ${#TARBALLS[@]} -eq 1 && -f "${TARBALLS[0]}" ]] || { echo "error: npm pack did not produce exactly one archive" >&2; exit 1; }
TARBALL="${TARBALLS[0]}"
ARCHIVE_SHA256="$(sha256_file "$TARBALL")"
if [[ -n "$EXPECTED_SHA256" && "${ARCHIVE_SHA256,,}" != "${EXPECTED_SHA256,,}" ]]; then
  echo "error: package SHA-256 mismatch (expected $EXPECTED_SHA256, got $ARCHIVE_SHA256)" >&2
  exit 1
fi
echo "Package SHA-256: $ARCHIVE_SHA256"

COMMIT_ID="${SOURCE_COMMIT:0:12}"
[[ "$SOURCE_COMMIT" != unknown ]] || COMMIT_ID="unknown"
ARTIFACT_ID="${VERSION}-${COMMIT_ID}-${ARCHIVE_SHA256:0:12}"
FINAL_DIR="$INSTALL_ROOT/versions/$ARTIFACT_ID"
ARCHIVE_COPY="$INSTALL_ROOT/artifacts/$ARTIFACT_ID.tgz"
STAGE="$INSTALL_ROOT/versions/.${ARTIFACT_ID}.stage.$$"

if [[ -e "$FINAL_DIR" ]]; then
  EXISTING_SHA="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).tarSha256||""))}catch(_){process.exit(1)}' "$FINAL_DIR/release-manifest.json" 2>/dev/null || true)"
  [[ "$EXISTING_SHA" == "$ARCHIVE_SHA256" ]] || { echo "error: immutable artifact identity collision at $FINAL_DIR" >&2; exit 1; }
  echo "Verified existing immutable artifact: $ARTIFACT_ID"
else
  rm -rf -- "$STAGE"
  mkdir -p "$STAGE"
  npm install --prefix "$STAGE" --no-audit --no-fund --include=optional "$TARBALL"

  sqlite_runtime_ok() {
    (cd -- "$STAGE" && node -e 'const r=require("./node_modules/cli-provider-router/lib/sqlite-runtime").sqliteRuntimeStatus(); process.exit(r.available ? 0 : 1)') >/dev/null 2>&1
  }
  if ! sqlite_runtime_ok; then
    echo "Rebuilding optional SQLite support for $(node --version) ABI $NODE_ABI ..." >&2
    npm rebuild --prefix "$STAGE" better-sqlite3 >/dev/null 2>&1 || true
  fi
  if ! sqlite_runtime_ok; then
    echo "warning: SQLite support is unavailable; repair this exact install with: cpr doctor --repair" >&2
  fi

  CPR_BIN="$STAGE/node_modules/.bin/cpr"
  [[ -x "$CPR_BIN" ]] || { echo "error: installed cpr executable is missing" >&2; exit 1; }
  INSTALLED_VERSION="$(CPR_HOME="$CPR_HOME_VALUE" CPR_DATA_FILE="$CPR_HOME_VALUE/data/providers.json" "$CPR_BIN" --version)"
  [[ "$INSTALLED_VERSION" == "$VERSION" ]] || { echo "error: installed version check failed ($INSTALLED_VERSION)" >&2; exit 1; }
  CPR_HOME="$CPR_HOME_VALUE" CPR_DATA_FILE="$CPR_HOME_VALUE/data/providers.json" "$CPR_BIN" doctor >/dev/null

  node -e '
    const fs=require("fs");
    const [file,version,commit,tarSha,lockSha,nodeAbi,nodeVersion,platform,arch,dirty,artifactId]=process.argv.slice(1);
    const manifest={schemaVersion:1,package:"cli-provider-router",version,commit,tarSha256:tarSha,lockSha256:lockSha,nodeAbi,nodeVersion,platform,arch,sourceDirty:dirty==="true",artifactId,installedAt:new Date().toISOString()};
    fs.writeFileSync(file,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});
  ' "$STAGE/release-manifest.json" "$VERSION" "$SOURCE_COMMIT" "$ARCHIVE_SHA256" "$LOCK_SHA256" "$NODE_ABI" "$(node --version)" "$(node -p 'process.platform')" "$(node -p 'process.arch')" "$SOURCE_DIRTY" "$ARTIFACT_ID"
  mv -- "$STAGE" "$FINAL_DIR"
  STAGE=""
fi

if [[ -e "$ARCHIVE_COPY" ]]; then
  [[ "$(sha256_file "$ARCHIVE_COPY")" == "$ARCHIVE_SHA256" ]] || { echo "error: archived package checksum conflict at $ARCHIVE_COPY" >&2; exit 1; }
else
  cp -p -- "$TARBALL" "$ARCHIVE_COPY"
  chmod 600 "$ARCHIVE_COPY" 2>/dev/null || true
  printf '%s  %s\n' "$ARCHIVE_SHA256" "$(basename "$ARCHIVE_COPY")" >"$ARCHIVE_COPY.sha256"
  chmod 600 "$ARCHIVE_COPY.sha256" 2>/dev/null || true
fi

activate() {
  local current_tmp="$INSTALL_ROOT/.current.$$"
  rm -f -- "$current_tmp"
  ln -s "versions/$ARTIFACT_ID" "$current_tmp"
  mv -f -- "$current_tmp" "$INSTALL_ROOT/current"

  local shim="$BIN_DIR/cpr" shim_tmp="$BIN_DIR/.cpr.$$"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'set -e'
    printf 'DEFAULT_CPR_HOME=%q\n' "$CPR_HOME_VALUE"
    printf 'INSTALL_ROOT=%q\n' "$INSTALL_ROOT"
    printf '%s\n' ': "${CPR_HOME:=$DEFAULT_CPR_HOME}"' 'export CPR_HOME' \
      ': "${CPR_DATA_FILE:=$CPR_HOME/data/providers.json}"' 'export CPR_DATA_FILE' \
      'exec "$INSTALL_ROOT/current/node_modules/.bin/cpr" "$@"'
  } >"$shim_tmp"
  chmod 755 "$shim_tmp"
  mv -f -- "$shim_tmp" "$shim"
  "$shim" --version >/dev/null
  "$shim" doctor >/dev/null
}

if ((ACTIVATE)); then activate; fi

if [[ -n "$RESULT_FILE" ]]; then
  mkdir -p "$(dirname -- "$RESULT_FILE")"
  RESULT_TMP="$RESULT_FILE.$$"
  node -e 'const fs=require("fs");const [f,dir,id,active]=process.argv.slice(1);fs.writeFileSync(f,JSON.stringify({finalDir:dir,artifactId:id,activated:active==="true"})+"\n",{mode:0o600})' \
    "$RESULT_TMP" "$FINAL_DIR" "$ARTIFACT_ID" "$([[ "$ACTIVATE" == 1 ]] && echo true || echo false)"
  mv -f -- "$RESULT_TMP" "$RESULT_FILE"
fi

echo "Installed cli-provider-router $VERSION"
echo "  command: $BIN_DIR/cpr"
echo "  app:     $FINAL_DIR"
echo "  data:    $CPR_HOME_VALUE"
echo "  sha256:  $ARCHIVE_SHA256"
echo "  commit:  $SOURCE_COMMIT"
echo "  ABI:     $NODE_ABI"
if ((ACTIVATE == 0)); then echo "  state:   staged (not active)"; fi
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "  note: add $BIN_DIR to PATH" ;; esac
