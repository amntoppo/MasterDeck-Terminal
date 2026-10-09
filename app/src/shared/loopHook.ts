/**
 * The loop hook (#82): one Stop hook entry, `<home>/workflows/loop.sh`, that keeps a session at a
 * workflow's Loop frame. At each turn end it takes the session's first open loop
 * (`workflows/loops/<sid>.json`, armed by the trigger hook), runs its check, and either lets the
 * stop through (the loop is over) or blocks it with the next round's message. It ignores
 * `stop_hook_active` on purpose: blocking again after a block is the point, and the iteration
 * counter is the guard. It writes nothing but `workflows/loops/` and `workflows/runs.jsonl`.
 */

/** The mark on the loop hook's settings.json entry (starts with the workflow hooks' mark). */
export const LOOP_MARK = 'masterdeck-workflow:loop'

/** The check's time limit, at most: the hook's own timeout is 600 s. */
export const LOOP_CHECK_MAX_S = 540

const esc = (p: string) => p.replace(/'/g, `'\\''`)

/** Where MasterDeck writes the loop hook. */
export const loopScriptPath = (home: string) => `${home.replace(/\/+$/, '')}/workflows/loop.sh`

/** The settings.json command that runs the loop hook. */
export const loopCommand = (home: string) => `bash '${esc(loopScriptPath(home))}' # ${LOOP_MARK}`

/**
 * The decision, one jq program so it can be tested alone. Input:
 * `{file, defs, result, now, sid, progress}`: the loop file, the compiled loops of the open loop's
 * step (`CompiledLoop[]`, from the session's workflow file), what the turn end found
 * (`{ran, passed, said, exit, tail, hash, ms}`), the time in ms, the session id and the progress
 * files' path prefix (`<dir>/workflows/loops/<sid>-`). Output:
 * `{file, answer, run, opened}`: the loop file to write, the hook's answer (null lets the stop
 * through), the `runs.jsonl` line (null when nothing ran) and the loops opened after this one
 * (their progress files are the shell's to create).
 *
 * First match wins: met, the iteration limit (`limits.iterations` plus the `extra` that Run 5 more
 * adds), the time limit, the stall limit (the last `stall` hashes equal: check output with
 * durations taken out, and the git fingerprint; only rounds after `stallFrom`, which Run 5 more sets), else the loop goes on. A loop that closes opens
 * the loops of its step that come after it by that outcome or by a plain arrow (S11), and hands
 * over, in order, its met or limit branch, what its plain arrows lead to, and the loops it opened.
 */
export const DECIDE = String.raw`
def plural($n; $w): "\($n) \($w)\(if $n == 1 then "" else "s" end)";
def set: type == "string" and test("\\S");
def fresh($step; $now): {id, step: $step, state: "open", iteration: 0, startedAt: $now, history: [], reason: null, lastCheck: null};
. as $in
| ($in.file.loops | [range(0; length) as $i | select((.[$i] | type) == "object" and .[$i].state == "open") | $i][0]) as $k
| if $k == null then {file: $in.file, answer: null, run: null, opened: []} else
  $in.file.loops[$k] as $e
  | ([$in.defs[]? | select(.id == $e.id)][0]) as $def
  | if $def == null then
      # The workflow was read and no longer has this loop: nothing could ever end it, so it ends
      # here. (A workflow the shell could not read never gets this far.)
      {file: ($in.file | .loops[$k] = ($e + {state: "stopped", reason: "the workflow no longer has this loop"})),
       answer: null, opened: [],
       run: {at: $in.now, sid: $in.sid, trigger: "loop", ids: $e.id, iteration: ($e.iteration // 0), state: "stopped"}}
    else
      $in.result as $r
      | (($e.iteration // 0) + 1) as $n
      | ($def.check.command | set) as $cmd
      | ($def.agentDone.on == true) as $agent
      | ((($cmd | not) or $r.passed) and (($agent | not) or $r.said)) as $met
      | ($def.limits.iterations + ($e.extra // 0)) as $max
      | ($in.now - ($e.startedAt // $in.now)) as $elapsed
      | ($def.limits.minutes // 0) as $mins
      | ($def.limits.stall // 0) as $stall
      | {n: $n, at: $in.now, ms: $r.ms, passed: $r.passed, said: $r.said, exit: $r.exit, tail: $r.tail, hash: $r.hash} as $h
      | ((($e.history // []) + [$h]) | .[-50:]) as $hist
      # Rounds before Run 5 more (stallFrom) never count toward the stall limit: a loop given more
      # gets its own rounds before it can be stopped for no progress again.
      | [$hist[] | select((.n // 0) > ($e.stallFrom // 0))] as $since
      | (if $cmd and $r.ran and ($r.passed | not) then "\u0060\($def.check.command)\u0060 still failing"
         elif $agent and ($r.said | not) then "the agent has not said LOOP DONE"
         else "the criterion not met" end) as $what
      | (if $met then {state: "met", reason: "criterion met after \(plural($n; "iteration"))"}
         elif $n >= $max then {state: "limit", reason: "stopped: \($n)/\($max) iterations, \($what)"}
         elif $mins > 0 and $elapsed >= $mins * 60000 then {state: "limit", reason: "stopped: time limit (\($mins) min)"}
         elif $stall > 0 and ($since | length) >= $stall and ($since | .[(length - $stall):] | map(.hash) | unique | length) == 1
           then {state: "limit", reason: "stopped: no progress in \($stall) iterations"}
         else {state: "open", reason: null} end) as $d
      | ($e + {iteration: $n, history: $hist, lastCheck: $h} + $d) as $out
      | (if $d.state == "open" then []
         else [$in.defs[]? | select(.after.loop? == $e.id and (.after.via == $d.state or .after.via == "then"))
               | select(.id as $i | any($in.file.loops[]; .id? == $i and .state? == "open") | not)] end) as $next
      | ($in.file.loops | .[$k] = $out
         | reduce $next[] as $x (.; ($x | fresh($e.step; $in.now)) as $f
             | if any(.[]; .id? == $f.id) then map(if .id? == $f.id then $f else . end) else . + [$f] end)) as $loops
      | (if $d.state == "open" then
          {decision: "block",
           reason: ("↻ Loop \"\($def.name)\": iteration \($n)/\($max)"
             + (if $mins > 0 then ", \((($mins * 60000 - $elapsed) + 59999) / 60000 | floor | if . < 0 then 0 else . end) min left" else "" end)
             + ". "
             + (if $r.ran and ($r.passed | not) and $r.said then "Your LOOP DONE claim was not backed by the check:\n\($r.tail)\n"
                elif $r.ran and ($r.passed | not) then "The check failed:\n\($r.tail)\n"
                elif $agent and ($r.said | not) then "Not done yet. When the goal is reached (\($def.agentDone.goal)), end your turn with a line starting \"LOOP DONE:\" and why.\n"
                else "Not met yet.\n" end)
             + "Go on with the loop's steps:\n\($def.plan)\nAdd a note of what you tried to \($in.progress)\($e.id).md."),
           systemMessage: "↻ loop \($n)/\($max)"}
        else
          (if $d.state == "met" then $def.met else $def.limit end) as $branch
          | ($def.then // "") as $then
          | if ($branch | set) or ($then | set) or ($next | length) > 0 then
              {decision: "block",
               reason: ("Loop \"\($def.name)\" is \(if $d.state == "met" then "done" else "over" end): \($d.reason)."
                 + (if $branch | set then " Now:\n\($branch)" else "" end)
                 + (if $then | set then "\nAfter the loop:\n\($then)" else "" end)
                 + ([$next[] | "\nThen the loop \"\(.name)\" starts (MasterDeck checks it each time you finish a turn). Each round:\n\(.plan)\nAdd a note of what you tried to \($in.progress)\(.id).md."] | join(""))),
               systemMessage: "↻ loop \"\($def.name)\": \($d.reason)"}
            else null end
        end) as $answer
      | {file: ($in.file | .loops = $loops), answer: $answer, opened: [$next[].id],
         run: {at: $in.now, sid: $in.sid, trigger: "loop", ids: $e.id, iteration: $n, state: $d.state}}
    end
  end
`.trim()

/**
 * The check's verdict on its own output (the regular expression decides when there is one, else
 * the exit code). Input: `{exit, out, output, mode}`; a pattern jq cannot read fails the check.
 */
export const CHECK_PASSED = String.raw`
if (.output // "") == "" then .exit == 0
else (try (.out | test($re)) catch null) as $m
  | if $m == null then false elif .mode == "no-match" then ($m | not) else $m end
end
`.trim()

/**
 * The script (bash 3.2: macOS). `home` is MasterDeck's home (`MASTERDECK_HOME`). Without jq, an
 * unreadable loop file or no open loop, the stop goes through. The check runs in the session's
 * folder in its own process group (`set -m`: macOS has neither `timeout` nor `setsid`), so a check
 * that runs over its limit is killed with everything it started.
 */
export function loopScript(home: string): string {
  return `#!/bin/bash
# MasterDeck loop hook: written by MasterDeck at each launch; edits are overwritten.
H='${esc(home.replace(/\/+$/, ''))}'
in=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
sid=$(printf '%s' "$in" | jq -r '.session_id // "" | strings' 2>/dev/null)
case "$sid" in ""|*[!A-Za-z0-9-]*) exit 0;; esac
LD="$H/workflows/loops"; L="$LD/$sid.json"
[ -f "$L" ] || exit 0
# A loop file that is not one is left as it is, and the stop goes through.
cur=$(jq -ce 'if (.loops | type) == "array" then . else empty end' "$L" 2>/dev/null) || exit 0
e=$(printf '%s' "$cur" | jq -c '[.loops[] | select(.state? == "open")][0] // empty' 2>/dev/null)
[ -n "$e" ] || exit 0
f="$H/workflows/sessions/$sid.json"; [ -f "$f" ] || f="$H/workflow.json"
# A workflow file that is missing or not read (being written, a broken edit) says nothing about
# the loop: the stop goes through and the loop file is left alone. Only a workflow read without
# this loop ends it (DECIDE).
[ -f "$f" ] || exit 0
# The compiled loops of the open loop's step; when the workflow changed since it was armed (a new
# step id), the step that still has this loop.
defs=$(jq -c --argjson e "$e" '[.steps[]? | select(.id == $e.step) | .loops[]?] as $here | if any($here[]; .id == $e.id) then $here else [.steps[]? | select(any(.loops[]?; .id == $e.id)) | .loops[]?] end' "$f" 2>/dev/null) || exit 0
[ -n "$defs" ] || exit 0
cmd=''; re=''; mode=match; tmin=5; agent=false
eval "$(printf '%s' "$defs" | jq -r --argjson e "$e" '[.[] | select(.id == $e.id)][0] // empty | @sh "cmd=\\(.check.command // "") re=\\(.check.output // "") mode=\\(.check.outputMode // "match") tmin=\\(.check.timeoutMin // 5 | tostring) agent=\\(.agentDone.on == true | tostring)"' 2>/dev/null)"
cwd=$(printf '%s' "$in" | jq -r '.cwd // "" | strings' 2>/dev/null)
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"
# What the agent said: the input's last message (newer Claude Code), else the transcript's last
# assistant entry only (no text there = nothing said: an older entry is an earlier round's).
msg=$(printf '%s' "$in" | jq -r '.last_assistant_message // "" | strings' 2>/dev/null)
if [ -z "$msg" ]; then
  tp=$(printf '%s' "$in" | jq -r '.transcript_path // "" | strings' 2>/dev/null)
  [ -n "$tp" ] && [ -f "$tp" ] && msg=$(tail -n 200 "$tp" | jq -Rrs '[split("\\n")[] | (try fromjson catch null) | objects | select(.type == "assistant")] | last | (.message.content? // "") | if type == "string" then . elif type == "array" then ([.[]? | objects | select(.type == "text") | .text] | join("\\n")) else "" end' 2>/dev/null)
fi
said=false
printf '%s\\n' "$msg" | grep -q '^LOOP DONE:' && said=true
ran=false; passed=false; ec=null; ms=0; o="$LD/.check-$sid.$$"; : > "$o"
# With the agent's goal on and nothing said, the check is not run: a test run each turn the agent
# is mid-work would cost time for nothing.
if [ -n "$(printf '%s' "$cmd" | tr -d ' \\t\\n')" ] && { [ "$agent" != true ] || [ "$said" = true ]; }; then
  ran=true
  case "$tmin" in ""|*[!0-9]*) tmin=5;; esac
  T=$((tmin * 60))
  # Tests only: seconds instead of minutes.
  case "\${MASTERDECK_LOOP_TIMEOUT_S:-}" in ""|*[!0-9]*) ;; *) T=$MASTERDECK_LOOP_TIMEOUT_S;; esac
  [ "$T" -ge 1 ] 2>/dev/null || T=1
  [ "$T" -le ${LOOP_CHECK_MAX_S} ] || T=${LOOP_CHECK_MAX_S}
  t0=$(date +%s)
  {
    set -m
    sh -c "$cmd" </dev/null >"$o" 2>&1 &
    pid=$!
    ( sleep "$T"; : > "$o.over"; kill -TERM -- "-$pid"; sleep 2; kill -KILL -- "-$pid" ) </dev/null >/dev/null 2>&1 &
    wd=$!
    wait "$pid"; ec=$?
    kill -TERM -- "-$wd"
    # Reaped here, so its "Terminated" notice goes to /dev/null and not to the session's stderr.
    wait "$wd"
    [ -f "$o.over" ] && kill -KILL -- "-$pid"
    set +m
  } 2>/dev/null
  ms=$(( ($(date +%s) - t0) * 1000 ))
  if [ -f "$o.over" ]; then
    rm -f "$o.over"
    if [ "$((T % 60))" = 0 ]; then over="$((T / 60)) min"; else over="$T s"; fi
    printf '\\ncheck timed out after %s\\n' "$over" >> "$o"
  else
    passed=$(tail -c 1048576 "$o" | jq -Rs --argjson exit "$ec" --arg output "$re" --arg mode "$mode" --arg re "$re" '{exit: $exit, out: ., output: $output, mode: $mode} | ${CHECK_PASSED.replace(/\n/g, ' ')}' 2>/dev/null)
    [ "$passed" = true ] || passed=false
  fi
fi
tail=$(tail -n 40 "$o" | tail -c 4096 | jq -Rs . 2>/dev/null); [ -n "$tail" ] || tail='""'
rm -f "$o"
# No progress = the same output (durations taken out) and the same commit and working tree.
hash=$( { printf '%s' "$tail" | jq -r 'gsub("[0-9]+(\\\\.[0-9]+)? ?m?s\\\\b"; "")' 2>/dev/null; git rev-parse HEAD 2>/dev/null; git --no-optional-locks status --porcelain 2>/dev/null; } | cksum | awk '{print $1}')
res=$(jq -n --argjson ran "$ran" --argjson passed "$passed" --argjson said "$said" --argjson exit "$ec" --argjson tail "$tail" --arg hash "$hash" --argjson ms "$ms" '{ran: $ran, passed: $passed, said: $said, exit: $exit, tail: $tail, hash: $hash, ms: $ms}')
out=$(jq -nc --argjson file "$cur" --argjson defs "$defs" --argjson result "$res" --argjson now "$(date +%s)000" --arg sid "$sid" --arg progress "$LD/$sid-" '{file: $file, defs: $defs, result: $result, now: $now, sid: $sid, progress: $progress} | ${DECIDE.replace(/'/g, `'\\''`)}' 2>/dev/null) || exit 0
[ -n "$out" ] || exit 0
printf '%s' "$out" | jq -c '.file' > "$L.$$.tmp" 2>/dev/null || { rm -f "$L.$$.tmp"; exit 0; }
# Stop loop or Run 5 more while the check ran (the loop no longer open, or a new start): the
# user's write stands, and this round is not counted.
jq -e --argjson e "$e" 'any(.loops[]?; .id? == $e.id and .state? == "open" and .startedAt? == $e.startedAt)' "$L" >/dev/null 2>&1 || { rm -f "$L.$$.tmp"; exit 0; }
mv "$L.$$.tmp" "$L" || { rm -f "$L.$$.tmp"; exit 0; }
for id in $(printf '%s' "$out" | jq -r '.opened[]?'); do
  case "$id" in ""|*[!a-z0-9-]*) continue;; esac
  : > "$LD/$sid-$id.md"
done
printf '%s' "$out" | jq -c '.run | objects' >> "$H/workflows/runs.jsonl" 2>/dev/null
printf '%s' "$out" | jq -c '.answer | objects'
exit 0
`
}
