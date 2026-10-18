# PR watch: sessions resolve the threads they handled (#177): design

## Problem

The PR watch tells a session "resolve only threads you addressed" and passes a clipped text per
thread, nothing else. Threads that needed no change stay open, the session has to search GitHub
for each thread before it can act, and nothing checks afterwards.

## Decisions (the issue's recommendations, taken)

1. **One rule per thread** in the message, replacing #163's "resolve only threads you addressed":
   - addressed (fix pushed): reply with what changed and the commit, then resolve;
   - no change needed (already handled, not applicable, a question answered, a nit the session
     disagrees with): reply with the reason, then resolve;
   - needs the user (unclear, a product decision): reply starting `Waiting on the owner:`, leave it
     open, and tell the user.
2. **The message carries what the session needs**: per thread its GraphQL id (`PRRT_…`), path,
   line and link, then the reply and resolve commands (`gh api graphql` with `-f` variables, so no
   quoting of the body inside the query) and the account to post as (the watch's `viewer`, with
   `gh api user -q .login` to check). A thread has no `url` field in GitHub's schema: the link is
   its first comment's `url` (`first:comments(first:1){nodes{url}}`).
3. **Outcome per delivered thread**, kept on the watch (`threads`, in `pr-watch.json`, newest 30):
   `resolved` (GitHub says so), `open` (unresolved, its last comment is the session's own post:
   replied and left open), `pending` (unresolved, no reply from the session yet). Outcomes are
   updated on every full read. A thread the read no longer returns keeps its last outcome.
4. **Needs you** lists a PR's `open` threads: the rule leaves a thread open after a reply only when
   it needs the user, so "replied and left open" is the signal, whatever the reply's wording (no
   parsing of the marker). One `review` item per PR, id by the set of open thread ids, detail
   `{type: "threads", url}`, with Open (the session) and View on GitHub. It resolves when none is
   open any more ("threads resolved").
5. **The follow-up check**: a successful delivery records `follow` (thread ids, when). Each second
   `deliver()` watches the session: once it was seen busy and then its turn is over (as `canDeliver`:
   idle, or only background work such as a Monitor left), or 10 minutes after the delivery with the
   turn over, the check is due; the
   next poll reads the PR in full. Threads of the delivery still `pending` and never reminded (and
   not in a newer delivery waiting to go) get **one** reminder line, sent as a note at the next
   delivery. Each thread is reminded at most once (`reminded`). `open` threads are never nagged.
6. **Details**: the PR watch row shows a "Threads" list: path:line, who, outcome (resolved /
   replied, left open / no reply yet), linked to GitHub. `WatchInfo.threads` carries it (the
   remote snapshot does not take it).
7. **Comments and reviews**: the message says to reply to each on the PR; a review's inline
   comments arrive as threads and follow the thread rule.
8. Nothing changes about force-push and merge: the message still forbids both.
9. The reply template single-quotes the body, so the own-post scanner (`shellWord` in
   `shared/ownPosts.ts`) reads a `'\''` apostrophe as part of it; otherwise a reply with an
   apostrophe would not count as the session's and would come back to it as news.

## Not done

- No marker parsing, no automatic resolve by MasterDeck: the session acts; MasterDeck checks.
- A thread older than the read window (newest 100 threads) is not followed (as today).
