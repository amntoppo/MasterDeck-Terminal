#!/usr/bin/env bash
# UserPromptSubmit: intercept "/queue ..." and store prompt instead of sending it.
set -euo pipefail
input=$(cat)
prompt=$(jq -r '.prompt // ""' <<<"$input")
[[ "$prompt" =~ ^/queue([[:space:]]|$) ]] || exit 0

sid=$(jq -r '.session_id // "default"' <<<"$input")
qfile="$HOME/.claude/queue/$sid.jsonl"
arg=$(printf '%s' "${prompt#/queue}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

block() { jq -n --arg r "$1" '{decision:"block", reason:$r}'; exit 0; }
count() { [[ -s "$qfile" ]] && wc -l <"$qfile" | tr -d ' ' || echo 0; }

case "$arg" in
  ""|list)
    [[ -s "$qfile" ]] || block "Queue empty."
    block "Queue ($(count)):"$'\n'"$(jq -r 'input_line_number as $n | "\($n). \(.)"' "$qfile" 2>/dev/null || nl -ba "$qfile")"
    ;;
  clear)
    rm -f "$qfile"; block "Queue cleared."
    ;;
  *)
    jq -cn --arg p "$arg" '$p' >>"$qfile"
    block "Queued #$(count): $arg"
    ;;
esac
