#!/usr/bin/env bash
# Stop: after Claude finishes a response, feed next queued prompt (FIFO).
set -euo pipefail
input=$(cat)
sid=$(jq -r '.session_id // "default"' <<<"$input")
qfile="$HOME/.claude/queue/$sid.jsonl"
[[ -s "$qfile" ]] || exit 0

next=$(head -n1 "$qfile" | jq -r '.')
tail -n +2 "$qfile" >"$qfile.tmp" && mv "$qfile.tmp" "$qfile"
[[ -s "$qfile" ]] || rm -f "$qfile"
left=$([[ -f "$qfile" ]] && wc -l <"$qfile" | tr -d ' ' || echo 0)

jq -n --arg p "$next" --arg left "$left" '{
  decision: "block",
  reason: ("Next queued user prompt (" + $left + " more after this). Treat it as a new user request and handle it fully:\n\n" + $p),
  systemMessage: ("▶ queue: " + $p)
}'
