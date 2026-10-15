// The macOS update helper (issue #122, spec §4): a bash 3.2 script MasterDeck writes to
// <userData>/updates/update-helper.sh and starts, detached, right before it quits. It swaps the
// staged app in by two renames, opens it, waits for the new app's health marker, and puts the
// previous app back when the new one does not come up. It never deletes the running app before the
// new one is in place, and the previous one stays (.MasterDeck.app.previous) until the new is healthy.
//
// Stand-ins (tests): MD_OPEN, MD_OSASCRIPT, MD_KILL (called with the app's path), MD_XATTR,
// MD_PID_WAIT (s, default 120), MD_HEALTH_WAIT (s, default 60), MD_POLL (s, default 1).

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
}

/** The script's arguments for one install. */
export function helperArgs(r: HelperRun): string[] {
  return ['install', String(r.pid), r.app, r.staged, r.dir, r.version, r.from, r.relaunch ? '1' : '0']
}

/** The script itself. Every path is quoted: "Application Support" has a space. */
export function helperScript(): string {
  return `#!/bin/bash
# MasterDeck update helper (written by MasterDeck: src/shared/updateHelper.ts). Runs under macOS bash 3.2.
#   update-helper.sh install <pid> <app> <staged app> <updates dir> <version> <from> <relaunch 1|0>
#   update-helper.sh swap <app> <staged app>    (as root through osascript when the folder is not writable)
#   update-helper.sh restore <app>
#   update-helper.sh cleanup <app>

SELF="$0"
OPEN="\${MD_OPEN:-/usr/bin/open}"
OSA="\${MD_OSASCRIPT:-/usr/bin/osascript}"
XATTR="\${MD_XATTR:-/usr/bin/xattr}"
PID_WAIT="\${MD_PID_WAIT:-120}"
HEALTH_WAIT="\${MD_HEALTH_WAIT:-60}"
POLL="\${MD_POLL:-1}"

prev_of() { printf '%s/.%s.previous' "$(dirname "$1")" "$(basename "$1")"; }
new_of() { printf '%s/.%s.new' "$(dirname "$1")" "$(basename "$1")"; }

# The staged app next to the current one, then two renames; the old one is kept as the backup.
do_swap() {
  app="$1"
  staged="$2"
  prev="$(prev_of "$app")"
  new="$(new_of "$app")"
  rm -rf "$prev" "$new" || return 1
  mv "$staged" "$new" || return 1
  if ! mv "$app" "$prev"; then
    rm -rf "$new"
    return 1
  fi
  if ! mv "$new" "$app"; then
    mv "$prev" "$app"
    return 1
  fi
  "$XATTR" -dr com.apple.quarantine "$app" >/dev/null 2>&1
  return 0
}

do_restore() {
  app="$1"
  prev="$(prev_of "$app")"
  [ -d "$prev" ] || return 1
  rm -rf "$app" && mv "$prev" "$app"
}

do_cleanup() {
  rm -rf "$(prev_of "$1")"
}

case "$1" in
  swap) do_swap "$2" "$3"; exit $? ;;
  restore) do_restore "$2"; exit $? ;;
  cleanup) do_cleanup "$2"; exit $? ;;
  install) ;;
  *) echo "usage: $0 install|swap|restore|cleanup ..." >&2; exit 2 ;;
esac

PID="$2"
APP="$3"
STAGED="$4"
DIR="$5"
VERSION="$6"
FROM="$7"
RELAUNCH="$8"
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

# The folder is not writable (an admin's /Applications): the moves run as root after macOS asks
# for the password. A cancel there is reason "permission".
ADMIN=0
if [ ! -w "$(dirname "$APP")" ] || [ ! -w "$APP" ]; then ADMIN=1; fi

priv() {
  if [ "$ADMIN" = 1 ]; then
    out="$("$OSA" -e 'on run argv' -e 'set c to ""' -e 'repeat with a in argv' -e 'set c to c & quoted form of (a as text) & " "' -e 'end repeat' -e 'do shell script c with administrator privileges' -e 'end run' /bin/bash "$SELF" "$@" 2>&1)"
    rc=$?
    [ -n "$out" ] && log "osascript: $out"
    if [ "$rc" != 0 ]; then
      case "$out" in
        *-128*) REASON="permission" ;;
        *) REASON="swap-failed" ;;
      esac
    fi
    return $rc
  fi
  /bin/bash "$SELF" "$@" >> "$LOG" 2>&1
  rc=$?
  [ "$rc" != 0 ] && REASON="swap-failed"
  return $rc
}

kill_app() {
  if [ -n "$MD_KILL" ]; then
    "$MD_KILL" "$APP"
  else
    /usr/bin/pkill -f "$APP/Contents/MacOS/" >/dev/null 2>&1
    sleep 3
    /usr/bin/pkill -9 -f "$APP/Contents/MacOS/" >/dev/null 2>&1
  fi
}

wait_healthy() {
  end=$((SECONDS + HEALTH_WAIT))
  while [ ! -f "$DIR/healthy-$VERSION" ]; do
    if [ "$SECONDS" -ge "$end" ]; then return 1; fi
    sleep "$POLL"
  done
  return 0
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

if [ ! -d "$STAGED" ]; then
  result_fail "missing"
  [ "$RELAUNCH" = 1 ] && "$OPEN" "$APP"
  exit 1
fi

# 2. The swap.
if ! priv swap "$APP" "$STAGED"; then
  result_fail "\${REASON:-swap-failed}"
  [ "$RELAUNCH" = 1 ] && "$OPEN" "$APP"
  exit 1
fi

# The next normal quit: no relaunch, so no health check (ponytail: the next launch's own marker).
if [ "$RELAUNCH" != 1 ]; then
  [ "$ADMIN" = 0 ] && do_cleanup "$APP"
  result_ok
  exit 0
fi

# 3. Open the new app and wait for its health marker; a second try, then roll back.
for try in 1 2; do
  rm -f "$DIR/healthy-$VERSION"
  log "open $VERSION (try $try)"
  "$OPEN" "$APP"
  if wait_healthy; then
    # ponytail: as root the backup stays until the next update's swap removes it (no second password).
    [ "$ADMIN" = 0 ] && do_cleanup "$APP"
    result_ok
    exit 0
  fi
  log "no health marker after \${HEALTH_WAIT}s"
  kill_app
done

REASON=""
if ! priv restore "$APP"; then log "restore failed: \${REASON}"; fi
result_fail "unhealthy"
"$OPEN" "$APP"
exit 1
`
}
