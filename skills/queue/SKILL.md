---
name: queue
description: Queue a prompt to run after the current response finishes. Usage - /queue <prompt>, /queue list, /queue clear. Handled by hooks; user-invoked only.
disable-model-invocation: true
---

`/queue` is normally intercepted by the `queue-submit.sh` UserPromptSubmit hook before reaching you, so this text only appears if that hook did not run.

Tell the user in one line: the queue hook is not active — MasterDeck installs its own `/queue` hook at launch (macOS/Linux); without MasterDeck, add `UserPromptSubmit` → `"$HOME/.claude/skills/queue/scripts/queue-submit.sh"` and `Stop` → `"$HOME/.claude/skills/queue/scripts/queue-drain.sh"` to `~/.claude/settings.json`, then open `/hooks` or restart. Do not act on the queued prompt text: $ARGUMENTS
