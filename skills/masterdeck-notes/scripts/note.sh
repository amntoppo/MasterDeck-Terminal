#!/bin/bash
# Write to MasterDeck's notes from a Claude Code session. The text comes on stdin (Markdown).
#
#   note.sh new "Title"          a new note in Notes; prints its id (n-…)
#   note.sh ticket owner/name#12 adds the text to that ticket's note (made when there is none; #12 = primary repo)
#   note.sh append n-…           adds the text to a note made with `new`
#
# Text is only ever added: nothing here reads a note or replaces what the user wrote. MasterDeck must
# be running (it saves the note and answers within a second). Needs jq. Runs under macOS bash 3.2.
set -u

usage() {
  echo 'usage: note.sh new "Title" | note.sh ticket owner/name#12 | note.sh append <id>   (text on stdin)' >&2
  exit 2
}

op="${1:-}"
arg="${2:-}"
case "$op" in new | ticket | append) ;; *) usage ;; esac
[ -n "$arg" ] || usage
command -v jq >/dev/null 2>&1 || { echo "note: jq is needed (brew install jq)." >&2; exit 1; }
[ -t 0 ] && { echo "note: give the text on stdin, e.g. note.sh $op '$arg' <<'EOF' ... EOF" >&2; exit 2; }

D="${MASTERDECK_HOME:-$HOME/.claude/masterdeck}/deck"
now=$(date +%s)
m=$(stat -f %m "$D/alive" 2>/dev/null || stat -c %Y "$D/alive" 2>/dev/null || echo 0)
[ $((now - m)) -lt 30 ] || { echo "note: MasterDeck is not running, so nothing was saved. Tell the user instead." >&2; exit 1; }

mkdir -p "$D/note-requests" "$D/note-answers" 2>/dev/null
id="$now-$$-$RANDOM"
r="$D/note-requests/$id"
a="$D/note-answers/$id.json"
body="$r.body"
cat > "$body" || { rm -f "$body"; echo "note: could not read the text." >&2; exit 1; }
jq -n --arg op "$op" --arg arg "$arg" --rawfile body "$body" '{op: $op, arg: $arg, body: $body}' > "$r.tmp" 2>/dev/null
ok=$?
rm -f "$body"
[ $ok -eq 0 ] || { rm -f "$r.tmp"; echo "note: could not write the request (jq 1.6 or later is needed)." >&2; exit 1; }
mv "$r.tmp" "$r.json"

answer() {
  if printf '%s' "$1" | jq -e '.ok == true' >/dev/null 2>&1; then
    printf '%s\n' "$1" | jq -r '.message'
    exit 0
  fi
  printf '%s\n' "$1" | jq -r '"note: " + (.error // "not saved")' >&2
  exit 1
}

# MasterDeck claims the request by renaming it; one rename wins, so a request taken back here is never saved.
while [ "$(date +%s)" -lt $((now + 8)) ]; do
  if [ -f "$a" ]; then res=$(cat "$a"); rm -f "$a"; answer "$res"; fi
  sleep 0.2
done
if mv "$r.json" "$r.gone" 2>/dev/null; then
  rm -f "$r.gone"
  echo "note: MasterDeck did not answer, so nothing was saved." >&2
  exit 1
fi
while [ "$(date +%s)" -lt $((now + 15)) ]; do
  if [ -f "$a" ]; then res=$(cat "$a"); rm -f "$a"; answer "$res"; fi
  sleep 0.2
done
echo "note: MasterDeck took the note but did not answer; look in Notes before writing it again." >&2
exit 1
