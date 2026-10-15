// The macOS update helper (issue #122, spec §4): a bash 3.2 script MasterDeck writes to
// <userData>/updates/update-helper.sh and starts, detached, right before it quits. It swaps the
// staged app in by two renames, opens it, waits for the new app's health marker, and puts the
// previous app back when the new one does not come up. It never deletes the running app before the
// new one is in place, and the previous one stays (.MasterDeck.app.previous) until the new is healthy
// (after an install on quit, the new app removes it itself: updateMac.ts removeMacBackup). It touches
// nothing while any process runs from the bundle (a relaunch, or the app opened again at once).
//
// Stand-ins (tests): MD_OPEN, MD_OSASCRIPT (run with the root command as its last argument),
// MD_KILL (called with the app's path), MD_XATTR, MD_PID_WAIT (s, default 120), MD_HEALTH_WAIT
// (s, default 120), MD_KILL_WAIT (s, default 3), MD_POLL (s, default 1).

/** The name the script is written under, in `<userData>/updates/`. */
export const HELPER_NAME = 'update-helper.sh'

export interface HelperRun {
  /** The process to wait for (the app that is quitting). */
  pid: number
  /** The installed bundle, e.g. /Applications/MasterDeck.app. */
  app: string
  /** The unpacked new bundle (<userData>/updates/<version>/stage/MasterDeck.app). */
  staged: string
  /** <userData>/updates: the health marker, result.json and the log are here. */
  dir: string
  version: string
  from: string
  /** Open the new app and check it (Restart now), or only swap (the next normal quit). */
  relaunch: boolean
  /** The downloaded zip, kept: an administrator install unpacks it again as root. */
  zip: string
  /** The zip's SHA-512 (base64) the app verified with the release signature. */
  sha512: string
}

/** The script's arguments for one install. */
export function helperArgs(r: HelperRun): string[] {
  return ['install', String(r.pid), r.app, r.staged, r.dir, r.version, r.from, r.relaunch ? '1' : '0', r.zip, r.sha512]
}

/** The script itself. Every path is quoted: "Application Support" has a space. */
export function helperScript(): string {
  return `#!/bin/bash
# MasterDeck update helper (written by MasterDeck: src/shared/updateHelper.ts). Runs under macOS bash 3.2.
#   update-helper.sh install <pid> <app> <staged app> <updates dir> <version> <from> <relaunch 1|0> <zip> <sha512>
# This file never runs as root. When the app's folder is not writable, the commands that need root
# go inline to osascript (do shell script … with administrator privileges): as root they copy the
# downloaded zip into a fresh root-owned folder, check its SHA-512 against the one the app verified
# with the release signature, unpack it there and check its version; the user's staged copy is not used.

OPEN="\${MD_OPEN:-/usr/bin/open}"
OSA="\${MD_OSASCRIPT:-/usr/bin/osascript}"
XATTR="\${MD_XATTR:-/usr/bin/xattr}"
PID_WAIT="\${MD_PID_WAIT:-120}"
HEALTH_WAIT="\${MD_HEALTH_WAIT:-120}"
KILL_WAIT="\${MD_KILL_WAIT:-3}"
POLL="\${MD_POLL:-1}"

# open starts the app without this environment: pass MasterDeck's own variables on, so an isolated
# launch (MASTERDECK_USER_DATA …) writes its health marker where this script waits for it.
ENV_ARGS=()
for name in $(compgen -e | sort); do
  case "$name" in
    MASTERDECK_*|MASTER_HOME|MASTER_WORKSPACE|CLAUDE_CONFIG_DIR) ENV_ARGS+=(--env "$name=\${!name}") ;;
  esac
done
open_app() { "$OPEN" \${ENV_ARGS[@]+"\${ENV_ARGS[@]}"} "$1"; }

if [ "$1" != install ] || [ $# -lt 10 ]; then
  echo "usage: $0 install <pid> <app> <staged app> <updates dir> <version> <from> <relaunch 1|0> <zip> <sha512>" >&2
  exit 2
fi

PID="$2"
APP="$3"
STAGED="$4"
DIR="$5"
VERSION="$6"
FROM="$7"
RELAUNCH="$8"
ZIP="$9"
SHA="\${10}"
PREV="$(dirname "$APP")/.$(basename "$APP").previous"
NEW="$(dirname "$APP")/.$(basename "$APP").new"
LOG="$DIR/helper.log"
REASON=""

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S') $*" >> "$LOG"; }

result_ok() {
  printf '{"ok":true,"from":"%s","version":"%s","at":%s000}\\n' "$FROM" "$VERSION" "$(date +%s)" > "$DIR/result.json.tmp" &&
    mv -f "$DIR/result.json.tmp" "$DIR/result.json"
  log "ok: $FROM -> $VERSION"
}

result_fail() {
  printf '{"ok":false,"version":"%s","reason":"%s","at":%s000}\\n' "$VERSION" "$1" "$(date +%s)" > "$DIR/result.json.tmp" &&
    mv -f "$DIR/result.json.tmp" "$DIR/result.json"
  log "failed: $1"
}

# One word for /bin/sh in single quotes, whatever it holds (spaces, quotes, $, backslashes).
sq() { printf "'%s'" "$(printf '%s' "$1" | /usr/bin/sed -e "s/'/'\\\\\\\\''/g")"; }

# The processes running from this bundle, matched as a plain path prefix (a folder name with ( or .
# is no pattern): the quitting app's own executable, or one opened again since.
app_pids() {
  /bin/ps -axo pid=,command= 2>/dev/null | while read -r p c; do
    case "$c" in
      "$APP/Contents/MacOS/"*) echo "$p" ;;
    esac
  done
}

kill_app() {
  if [ -n "$MD_KILL" ]; then
    "$MD_KILL" "$APP"
    return 0
  fi
  pids="$(app_pids)"
  [ -z "$pids" ] && return 0
  kill $pids 2>/dev/null
  end=$((SECONDS + KILL_WAIT))
  while [ -n "$(app_pids)" ] && [ "$SECONDS" -lt "$end" ]; do sleep "$POLL"; done
  pids="$(app_pids)"
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  return 0
}

wait_healthy() {
  end=$((SECONDS + HEALTH_WAIT))
  while [ ! -f "$DIR/healthy-$VERSION" ]; do
    if [ "$SECONDS" -ge "$end" ]; then return 1; fi
    sleep "$POLL"
  done
  return 0
}

# The folder is not writable (an admin's /Applications): the swap runs as root after macOS asks for
# the password. A cancel there is reason "permission".
ADMIN=0
if [ ! -w "$(dirname "$APP")" ] || [ ! -w "$APP" ]; then ADMIN=1; fi

# The values the root commands use, each quoted for /bin/sh.
ROOT_VARS="APP=$(sq "$APP"); PREV=$(sq "$PREV"); NEW=$(sq "$NEW"); ZIP=$(sq "$ZIP"); SHA=$(sq "$SHA"); VER=$(sq "$VERSION")"

# As root: the zip again, into a fresh root-owned folder, checked, unpacked, given the current app's
# owner; then the two renames, the old app back on failure. Exit codes say where it stopped.
read -r -d '' ROOT_SWAP <<'ROOTSWAP'
fail() { /bin/rm -rf "$T"; exit "$1"; }
T="$(/usr/bin/mktemp -d /tmp/masterdeck-update.XXXXXX)" || exit 10
/bin/cp "$ZIP" "$T/update.zip" || fail 11
[ "$(/usr/bin/openssl dgst -sha512 -binary "$T/update.zip" | /usr/bin/base64)" = "$SHA" ] || fail 12
/usr/bin/ditto -x -k "$T/update.zip" "$T/x" || fail 13
[ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw "$T/x/MasterDeck.app/Contents/Info.plist")" = "$VER" ] || fail 14
/usr/bin/xattr -dr com.apple.quarantine "$T/x/MasterDeck.app" >/dev/null 2>&1
/usr/sbin/chown -R "$(/usr/bin/stat -f %u:%g "$APP")" "$T/x/MasterDeck.app" || fail 15
/bin/rm -rf "$PREV" "$NEW" || fail 16
/bin/mv "$T/x/MasterDeck.app" "$NEW" || fail 16
/bin/mv "$APP" "$PREV" || { /bin/rm -rf "$NEW"; fail 16; }
/bin/mv "$NEW" "$APP" || { /bin/mv "$PREV" "$APP"; fail 16; }
/bin/rm -rf "$T"
ROOTSWAP

read -r -d '' ROOT_RESTORE <<'ROOTRESTORE'
[ -d "$PREV" ] && [ ! -L "$PREV" ] || exit 1
/bin/rm -rf "$APP" && /bin/mv "$PREV" "$APP"
ROOTRESTORE

as_root() {
  out="$("$OSA" -e 'on run argv' -e 'do shell script (item 1 of argv) with administrator privileges' -e 'end run' "$ROOT_VARS
$1" 2>&1)"
  rc=$?
  [ -n "$out" ] && log "osascript ($rc): $out"
  if [ "$rc" != 0 ]; then
    case "$out" in
      *-128*) REASON="permission" ;;
      *) REASON="swap-failed" ;;
    esac
  fi
  return $rc
}

# As the user: the staged app next to the current one, then two renames; the old one is kept as the backup.
swap_user() {
  rm -rf "$PREV" "$NEW" || return 1
  mv "$STAGED" "$NEW" || return 1
  if ! mv "$APP" "$PREV"; then
    rm -rf "$NEW"
    return 1
  fi
  if ! mv "$NEW" "$APP"; then
    mv "$PREV" "$APP"
    return 1
  fi
  "$XATTR" -dr com.apple.quarantine "$APP" >/dev/null 2>&1
  return 0
}

do_swap() {
  if [ "$ADMIN" = 1 ]; then
    as_root "$ROOT_SWAP"
    return $?
  fi
  swap_user >> "$LOG" 2>&1 && return 0
  REASON="swap-failed"
  return 1
}

do_restore() {
  if [ "$ADMIN" = 1 ]; then
    as_root "$ROOT_RESTORE"
    return $?
  fi
  [ -d "$PREV" ] || return 1
  rm -rf "$APP" && mv "$PREV" "$APP"
}

log "install $VERSION over $FROM (pid $PID, relaunch $RELAUNCH, admin $ADMIN)"

# 1. The old app quits normally (its terminals and remote line close); give it two minutes.
end=$((SECONDS + PID_WAIT))
while kill -0 "$PID" 2>/dev/null; do
  if [ "$SECONDS" -ge "$end" ]; then
    result_fail "still-running"
    exit 1
  fi
  sleep "$POLL"
done

# 2. Nothing may run from the bundle while it is swapped (a relaunch, or the app opened again at
# once): leave everything as it is; the next quit tries again.
if [ -n "$(app_pids)" ]; then
  log "MasterDeck runs again from $APP"
  result_fail "still-running"
  exit 1
fi

if [ "$ADMIN" = 1 ]; then src="$ZIP"; else src="$STAGED"; fi
if [ ! -e "$src" ]; then
  result_fail "missing"
  [ "$RELAUNCH" = 1 ] && open_app "$APP"
  exit 1
fi

# 3. The swap.
if ! do_swap; then
  result_fail "\${REASON:-swap-failed}"
  [ "$RELAUNCH" = 1 ] && open_app "$APP"
  exit 1
fi

# The next normal quit: no relaunch, so no health check here. The backup stays: the new app
# removes it once it has written its own health marker (no automatic rollback on this path).
if [ "$RELAUNCH" != 1 ]; then
  result_ok
  exit 0
fi

# 4. Open the new app and wait for its health marker; a second try, then roll back.
for try in 1 2; do
  rm -f "$DIR/healthy-$VERSION"
  log "open $VERSION (try $try)"
  open_app "$APP"
  if wait_healthy; then
    # ponytail: as root the backup stays until the next update's swap removes it (no second password).
    [ "$ADMIN" = 0 ] && rm -rf "$PREV"
    result_ok
    exit 0
  fi
  log "no health marker after \${HEALTH_WAIT}s"
  kill_app
done

REASON=""
if ! do_restore; then log "restore failed: \${REASON}"; fi
result_fail "unhealthy"
open_app "$APP"
exit 1
`
}
