#!/usr/bin/env bash
# Installs the Matrix homeserver (Synapse), the mautrix-gmessages bridge and background services on this Mac.
#
# Everything the background services touch lives in ~/Library/Application Support/music-over-rcs, NOT in this project
# folder: macOS stops launchd jobs from reading ~/Documents, ~/Desktop and ~/Downloads, and a service started from
# there hangs on its first file access.
#
# Run as yourself (not root):  bash deploy/mac/setup.sh
# Idempotent: every step checks what already exists. Prints no secrets.
#
# Optional environment:
#   MORS_HOME         where the services live (default ~/Library/Application Support/music-over-rcs)
#   SYNAPSE_VERSION   default 1.143.0 (the newest release with prebuilt macOS packages; later ones need a Rust compiler)
#   BRIDGE_VERSION    default v0.2609.0
#   BRIDGE_SHA256     SHA-256 of that release's mautrix-gmessages-darwin-arm64 (as published by GitHub)
#   MATRIX_LOCALPART  your Matrix username, which gets bridge admin rights (default me)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
RT=${MORS_HOME:-$HOME/Library/Application Support/music-over-rcs}
VENV=$RT/venv
SYNAPSE_DIR=$RT/synapse
GM_DIR=$RT/gmessages
BOT_DIR=$RT/bot
LOG_DIR=$RT/logs
LAUNCHD_DIR=$RT/launchd
CATALOG=$RT/catalog.db
AGENTS_DIR=$HOME/Library/LaunchAgents
SYNAPSE_VERSION=${SYNAPSE_VERSION:-1.143.0}
BRIDGE_VERSION=${BRIDGE_VERSION:-v0.2609.0}
BRIDGE_ASSET=mautrix-gmessages-darwin-arm64
BRIDGE_SHA256=${BRIDGE_SHA256:-4e271873ee3ab642bba1cff019ab9a6b626ea6d45439d5edb3060739da1c9f6b}
OLM_VERSION=3.2.16
MATRIX_LOCALPART=${MATRIX_LOCALPART:-me}
UID_NUM=$(id -u)

log() { printf '\n== %s\n' "$*"; }

env_set() { # KEY RAW_VALUE: set one line in the project's .env, creating the file (mode 600) if needed
  local key=$1 value=$2 file=$ROOT/.env tmp line
  [ -f "$file" ] || { : > "$file"; chmod 600 "$file"; }
  if grep -q "^$key=" "$file"; then
    tmp=$(mktemp)
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in "$key="*) printf '%s=%s\n' "$key" "$value" ;; *) printf '%s\n' "$line" ;; esac
    done < "$file" > "$tmp"
    cat "$tmp" > "$file"; rm -f "$tmp"
  else
    if [ -s "$file" ] && [ -n "$(tail -c1 "$file")" ]; then echo >> "$file"; fi
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

log "Checking this Mac"
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "this script is for Apple-silicon Macs" >&2; exit 1; }
case "$RT" in
  "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*|"$HOME/Library/Mobile Documents"*)
    echo "$RT is in a folder macOS keeps background services out of; choose another MORS_HOME" >&2; exit 1 ;;
esac
python3 -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10 or newer is needed"'
NODE=$(command -v node) || { echo "Node.js is not installed" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' || { echo "Node 22.18 or newer is needed" >&2; exit 1; }
echo "python $(python3 --version | cut -d' ' -f2), node $("$NODE" -v)"
echo "project:  $ROOT"
echo "services: $RT"
for port in 8008 29336; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl list 2>/dev/null | grep -q com.musicoverrcs; then
    echo "port $port is already in use by something else" >&2; exit 1
  fi
done
mkdir -p "$RT" "$SYNAPSE_DIR" "$GM_DIR" "$BOT_DIR" "$LOG_DIR" "$LAUNCHD_DIR" "$AGENTS_DIR"
chmod 700 "$RT" "$LOG_DIR"

log "Synapse $SYNAPSE_VERSION (prebuilt packages only; nothing is compiled)"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
# prometheus-client 0.24 made its Collector class a typing Protocol, which Synapse 1.143.0 cannot subclass.
# requests is only needed by Synapse's register_new_matrix_user script, which 'stack create-user' runs.
"$VENV/bin/pip" install --quiet --disable-pip-version-check --only-binary=:all: "matrix-synapse==$SYNAPSE_VERSION" "prometheus-client<0.24" requests
"$VENV/bin/python" -c 'import synapse; print("synapse", synapse.__version__)'

if [ ! -f "$SYNAPSE_DIR/homeserver.yaml" ]; then
  log "Generating the Synapse config (server name: localhost)"
  "$VENV/bin/python" -m synapse.app.homeserver --server-name localhost --config-path "$SYNAPSE_DIR/homeserver.yaml" \
    --data-directory "$SYNAPSE_DIR" --generate-config --report-stats=no
fi
chmod 600 "$SYNAPSE_DIR/homeserver.yaml"

log "Checking that Synapse listens on this Mac only, and keeping its logs small"
"$VENV/bin/python" - "$SYNAPSE_DIR" <<'PY'
import sys, yaml
directory = sys.argv[1]
cfg = yaml.safe_load(open(f"{directory}/homeserver.yaml"))
bad = [(l.get("port"), a) for l in cfg.get("listeners", []) for a in l.get("bind_addresses", ["0.0.0.0"]) if a not in ("127.0.0.1", "::1", "localhost")]
if bad:
    sys.exit(f"Synapse would listen beyond localhost: {bad}")
print("listeners:", [(l.get("port"), l.get("bind_addresses")) for l in cfg.get("listeners", [])])
# The generated log config writes a file into whatever folder the generator ran from, at INFO level, which would
# record every request the bot makes. Log warnings and errors to the console instead: launchd collects them in logs/.
log_path = f"{directory}/localhost.log.config"
log_cfg = yaml.safe_load(open(log_path))
log_cfg["handlers"] = {name: h for name, h in (log_cfg.get("handlers") or {}).items() if name == "console"}
log_cfg.setdefault("root", {})["level"] = "WARNING"
log_cfg["root"]["handlers"] = ["console"]
for logger in (log_cfg.get("loggers") or {}).values():
    logger["level"] = "WARNING"
yaml.safe_dump(log_cfg, open(log_path, "w"), sort_keys=False)
print("log level:", log_cfg["root"]["level"], "| handlers:", log_cfg["root"]["handlers"])
PY

log "mautrix-gmessages $BRIDGE_VERSION"
if [ ! -x "$GM_DIR/mautrix-gmessages" ]; then
  curl -fL --retry 3 -sS -o "$GM_DIR/.download" "https://github.com/mautrix/gmessages/releases/download/$BRIDGE_VERSION/$BRIDGE_ASSET"
  got=$(shasum -a 256 "$GM_DIR/.download" | awk '{print $1}')
  if [ "$got" != "$BRIDGE_SHA256" ]; then rm -f "$GM_DIR/.download"; echo "CHECKSUM MISMATCH: expected $BRIDGE_SHA256, got $got" >&2; exit 1; fi
  echo "checksum ok: $BRIDGE_ASSET ($(du -h "$GM_DIR/.download" | cut -f1))"
  mv "$GM_DIR/.download" "$GM_DIR/mautrix-gmessages"
  chmod 755 "$GM_DIR/mautrix-gmessages"
  codesign -dv "$GM_DIR/mautrix-gmessages" >/dev/null 2>&1 || codesign --force --sign - "$GM_DIR/mautrix-gmessages"
else
  echo "binary already installed"
fi

log "libolm $OLM_VERSION (the bridge's release binary links it; Homebrew no longer ships it, so it is built from source)"
if [ ! -f "$GM_DIR/libolm.3.dylib" ]; then
  command -v cmake >/dev/null && command -v c++ >/dev/null || { echo "building libolm needs cmake and the Xcode command-line tools" >&2; exit 1; }
  work=$(mktemp -d)
  curl -fL --retry 3 -sS -o "$work/olm.tar.gz" "https://gitlab.matrix.org/matrix-org/olm/-/archive/$OLM_VERSION/olm-$OLM_VERSION.tar.gz"
  echo "downloaded libolm source ($(du -h "$work/olm.tar.gz" | cut -f1), sha256 $(shasum -a 256 "$work/olm.tar.gz" | cut -d' ' -f1))"
  tar xzf "$work/olm.tar.gz" -C "$work"
  src=$work/olm-$OLM_VERSION
  # List::operator= in 3.2.16 increments a const pointer and dereferences the wrong variable. Nothing calls it, but current clang rejects it.
  sed -i '' 's|T \* const other_pos = other._data;|T const * other_pos = other._data;|; s|\*this_pos = \*other;|*this_pos = *other_pos;|' "$src/include/olm/list.hh"
  grep -q 'T const \* other_pos' "$src/include/olm/list.hh" || { echo "the libolm source layout changed; cannot patch it" >&2; rm -rf "$work"; exit 1; }
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DOLM_TESTS=OFF \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_OSX_ARCHITECTURES=arm64 >/dev/null 2>&1
  cmake --build "$src/build" -j"$(sysctl -n hw.ncpu)" >/dev/null
  cp "$src/build/libolm.$OLM_VERSION.dylib" "$GM_DIR/libolm.3.dylib"
  rm -rf "$work"
  echo "built libolm.3.dylib ($(du -h "$GM_DIR/libolm.3.dylib" | cut -f1))"
else
  echo "libolm already built"
fi
(cd "$GM_DIR" && ./mautrix-gmessages --version 2>&1 | head -2) || true

if [ ! -f "$GM_DIR/config.yaml" ]; then
  log "Generating the bridge config"
  (cd "$GM_DIR" && ./mautrix-gmessages -e)
fi

log "Patching the bridge config (homeserver, appservice address, SQLite, who may use it)"
"$VENV/bin/python" - "$GM_DIR/config.yaml" "$MATRIX_LOCALPART" <<'PY'
import re, sys, yaml
path, user = sys.argv[1], sys.argv[2]
lines = open(path).read().split("\n")
indent = next((re.match(r"^(\s+)", l).group(1) for l in lines if re.match(r"^\s+\S", l) and not l.lstrip().startswith("#")), "    ")
required = {
    ("homeserver", "address"): "http://127.0.0.1:8008",
    ("homeserver", "domain"): "localhost",
    ("appservice", "address"): "http://127.0.0.1:29336",
    ("database", "type"): "sqlite3-fk-wal",
    ("database", "uri"): "file:mautrix-gmessages.db?_txlock=immediate",
}
optional = {
    ("appservice", "hostname"): "127.0.0.1",  # listen on this Mac only, not on the network
    ("logging", "min_level"): "info",         # the example config logs at debug level
}
edits = {**required, **optional}
applied, out, section, i = set(), [], None, 0
while i < len(lines):
    line = lines[i]
    top = re.match(r"^([A-Za-z0-9_]+):\s*(#.*)?$", line)
    if top:
        section = top.group(1)
    elif re.match(r"^\S", line) and not line.startswith("#"):
        section = None
    key = re.match(rf"^{re.escape(indent)}([A-Za-z0-9_]+):", line)
    if section and key and (section, key.group(1)) in edits:
        out.append(f'{indent}{key.group(1)}: "{edits[(section, key.group(1))]}"')
        applied.add((section, key.group(1)))
    elif section == "bridge" and key and key.group(1) == "permissions":
        out.append(f"{indent}permissions:")
        out.append(f'{indent}{indent}"@{user}:localhost": admin')
        applied.add(("bridge", "permissions"))
        i += 1
        while i < len(lines) and (not lines[i].strip() or lines[i].startswith(indent + indent) or lines[i].lstrip().startswith("#")):
            i += 1
        continue
    else:
        out.append(line)
    i += 1
missing = (set(required) | {("bridge", "permissions")}) - applied
if missing:
    sys.exit(f"could not find these keys in the generated config (its layout may have changed): {sorted(missing)}")
open(path, "w").write("\n".join(out))
cfg = yaml.safe_load(open(path))
assert cfg["homeserver"]["address"] == "http://127.0.0.1:8008" and cfg["homeserver"]["domain"] == "localhost"
assert cfg["appservice"]["address"] == "http://127.0.0.1:29336"
assert cfg["database"]["type"] == "sqlite3-fk-wal"
assert cfg["bridge"]["permissions"] == {f"@{user}:localhost": "admin"}
listen = cfg["appservice"].get("hostname")
if listen is None:
    print("WARNING: appservice.hostname is not in the config; check where the bridge listens (lsof -iTCP:29336)")
elif listen not in ("127.0.0.1", "localhost", "::1"):
    sys.exit(f"the bridge would listen beyond this Mac: appservice.hostname = {listen}")
print("patched and verified: homeserver", cfg["homeserver"]["address"], "| appservice", cfg["appservice"]["address"],
      "listening on", listen, "| database", cfg["database"]["type"], "| permissions", cfg["bridge"]["permissions"])
print("log level:", cfg.get("logging", {}).get("min_level"), "| encryption.allow:", cfg.get("encryption", {}).get("allow"))
PY
chmod 600 "$GM_DIR/config.yaml"

if [ ! -f "$GM_DIR/registration.yaml" ]; then
  log "Generating the appservice registration"
  (cd "$GM_DIR" && ./mautrix-gmessages -g)
fi
chmod 600 "$GM_DIR/registration.yaml"
echo "registration.yaml present: $(test -s "$GM_DIR/registration.yaml" && echo yes || echo NO)"

log "Telling Synapse about the bridge, and tidying its media"
"$VENV/bin/python" - "$SYNAPSE_DIR/homeserver.yaml" "$GM_DIR/registration.yaml" <<'PY'
import json, sys, yaml
path, registration = sys.argv[1], sys.argv[2]
cfg = yaml.safe_load(open(path))
existing = cfg.get("app_service_config_files") or []
if existing and registration not in existing:
    sys.exit("homeserver.yaml already lists other appservices; merge by hand")
additions = []
if registration not in existing:
    additions.append(f"app_service_config_files:\n  - {json.dumps(registration)}")
if "max_upload_size" not in cfg:
    additions.append("max_upload_size: 100M")
if "federation_domain_whitelist" not in cfg:
    additions.append("federation_domain_whitelist: []")
if "suppress_key_server_warning" not in cfg:
    additions.append("suppress_key_server_warning: true")
if "media_retention" not in cfg:
    additions.append("media_retention:\n  local_media_lifetime: 7d\n  remote_media_lifetime: 7d")
if additions:
    with open(path, "a") as f:
        f.write("\n# --- added by music-over-rcs setup ---\n" + "\n".join(additions) + "\n")
cfg = yaml.safe_load(open(path))
assert registration in cfg["app_service_config_files"]
print("synapse extras:", {k: cfg[k] for k in ("max_upload_size", "federation_domain_whitelist", "media_retention")})
PY

write_plist() { # label workdir logfile program [args...]
  local label=$1 workdir=$2 logfile=$3; shift 3
  local args="" a
  for a in "$@"; do args+="    <string>$a</string>"$'\n'; done
  cat > "$LAUNCHD_DIR/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key><string>$workdir</string>
  <key>StandardOutPath</key><string>$logfile</string>
  <key>StandardErrorPath</key><string>$logfile</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>Nice</key><integer>5</integer>
</dict>
</plist>
PLIST
  plutil -lint "$LAUNCHD_DIR/$label.plist" >/dev/null
}

log "Background services (launchd user agents: start at login, restart if they crash, low priority)"
write_plist com.musicoverrcs.synapse "$SYNAPSE_DIR" "$LOG_DIR/synapse.log" "$VENV/bin/python" -m synapse.app.homeserver -c "$SYNAPSE_DIR/homeserver.yaml"
write_plist com.musicoverrcs.bridge "$GM_DIR" "$LOG_DIR/bridge.log" "$GM_DIR/mautrix-gmessages"
write_plist com.musicoverrcs.bot "$BOT_DIR" "$LOG_DIR/bot.log" "$NODE" --disable-warning=ExperimentalWarning src/matrix-main.ts
echo "wrote 3 service definitions in $LAUNCHD_DIR"
echo "installing the homeserver and the bridge now; the bot's is installed later by 'stack enable-bot', once you have logged in"

for label in com.musicoverrcs.synapse com.musicoverrcs.bridge; do
  cp "$LAUNCHD_DIR/$label.plist" "$AGENTS_DIR/$label.plist"
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl enable "gui/$UID_NUM/$label"
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/$label.plist"
done

log "Waiting for the homeserver (the first start builds its database)"
for _ in $(seq 1 45); do
  if curl -fsS -m 3 http://127.0.0.1:8008/_matrix/client/versions >/dev/null 2>&1; then echo "homeserver is answering on 127.0.0.1:8008"; break; fi
  sleep 2
done
if ! curl -fsS -m 3 http://127.0.0.1:8008/_matrix/client/versions >/dev/null 2>&1; then
  echo "the homeserver did not come up. Last lines of $LOG_DIR/synapse.log:" >&2
  tail -n 25 "$LOG_DIR/synapse.log" >&2 || true
  exit 1
fi

log "Waiting for the bridge to reach the homeserver (it creates its bot user @gmessagesbot:localhost)"
for _ in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:8008/_matrix/client/v3/profile/@gmessagesbot:localhost" >/dev/null 2>&1; then echo "bridge bot exists: the bridge and the homeserver are talking"; break; fi
  sleep 2
done
if ! curl -fsS -m 3 "http://127.0.0.1:8008/_matrix/client/v3/profile/@gmessagesbot:localhost" >/dev/null 2>&1; then
  echo "the bridge has not registered its bot yet. Last lines of $LOG_DIR/bridge.log:" >&2
  tail -n 25 "$LOG_DIR/bridge.log" >&2 || true
  exit 1
fi

log "Checking that nothing listens beyond this Mac"
listeners=$(lsof -nP -iTCP:8008 -iTCP:29336 -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1 " " $9}' | sort -u)
echo "$listeners" | sed 's/^/  /'
if echo "$listeners" | grep -qE ' (\*|\[::\]|0\.0\.0\.0):'; then echo "something is reachable from the network; see above" >&2; exit 1; fi

log "Catalog and settings (the bot cannot read this project folder, so the catalog lives with the services)"
if [ ! -f "$CATALOG" ] && [ -f "$ROOT/data/catalog.db" ]; then
  rows=$("$NODE" --disable-warning=ExperimentalWarning -e 'const {DatabaseSync}=require("node:sqlite"); console.log(new DatabaseSync(process.argv[1],{readOnly:true}).prepare("select count(*) c from tracks").get().c)' "$ROOT/data/catalog.db" 2>/dev/null || echo 0)
  if [ "${rows:-0}" -gt 0 ]; then
    "$NODE" --disable-warning=ExperimentalWarning -e 'const {DatabaseSync}=require("node:sqlite"); new DatabaseSync(process.argv[1]).exec("VACUUM INTO \x27" + process.argv[2].replace(/\x27/g, "\x27\x27") + "\x27")' "$ROOT/data/catalog.db" "$CATALOG"
    echo "copied your $rows tracks from data/catalog.db"
  fi
fi
env_set CATALOG_DB "\"$CATALOG\""
echo "CATALOG_DB in .env -> $CATALOG ('npm run catalog' and the bot now share it)"
bash "$ROOT/deploy/mac/stack" sync-bot
echo
bash "$ROOT/deploy/mac/stack" status
echo
echo "Done. Next: create your account ('npm run stack -- create-user'), then 'npm run matrix-login'."
