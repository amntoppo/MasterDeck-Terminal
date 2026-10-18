# Watch any PR (#182): design

Today a PR watch (`main/prWatch.ts`) starts only by itself, for a session's own open PR, when
**Watch new PRs** is on and the session's workflow keeps `pr-watch`. The Pull requests view does
not say which PRs are watched and cannot watch one. This adds an eye on every PR (row and popup)
and a **Watched PRs** list with an **Add** field in the Review with Claude widget.

## Decisions (the recommended ones, taken)

1. **One store.** Every watch, automatic or manual, is a `PrWatch` entry in `pr-watch.json`. A
   manual one carries `manual: true`, the PR tab it was started from (`tabId`, `tabName`) and reads
   GitHub as that tab's account. One watch per PR URL: turning the eye on for a PR already watched
   (by its session, or from another tab) reuses that watch and says so.
2. **Where events go is decided again on every state build.** A PR is *owned* by a session when
   `ownerOf` (shared/offers.ts: the session's `sessionPrs`, or the session of the issue the PR
   closes) finds a live one. Owned: events go to that session exactly as an automatic watch's do
   (same message, same delivery rules: `canDeliver`, the held-message rules of #163/#177). Not
   owned: they go to the tab's **Review with Claude** session. The owner can appear later (the
   session links the PR) or go (the session ends): the watch follows; a manual watch is never
   dropped because its session went.
3. **A manual watch starts quiet**: what is on the PR when the eye is clicked is not news (the
   user is looking at it). It does not end when the PR's author is not the account (automatic
   watches end then, as before).
4. **Routed to the review session** (no owner):
   - **New commits** (the light read's `headRefOid` changed): Automate Review queues a review of
     the PR for that tab, with its prompt, its post script's `--auto` form and its rules, also
     while Automate Review is off for the tab (a *watched track*). After that review the track
     follows the PR as any other (new commits → reviewed again). **Merge automatically** still
     merges only a PR it reviewed, at the reviewed head, with the switch on (`mergeGuard`
     unchanged; a watched track in a tab with Automate Review off is never merged).
   - **Comments, reviews, review threads, a merge conflict**: one line typed into the review
     session once its turn is over (`[MasterDeck PR watch] … Summarise them for me …`): it asks
     for a summary, never a reply, a push or a merge. Everything the account posted is the review
     session's own and is not news. Claude-review stall nudges are not sent (that is the PR
     author's business).
   - **Ready to merge** (open, not a draft, MERGEABLE, approved, checks green or none, merge state
     CLEAN), once per head; **merged**; **closed**; **can't read it any more**: Needs you (type
     `auto-review`, "Automated review"). A ready notice is left to Automate Review when it follows
     the PR itself (its own `ready:<head>` notice), and a merge it made is told by it only.
   - No review session runs: MasterDeck starts one as Automate Review does (at most one start per
     5 minutes per tab).
5. **Turning the eye off** ends the watch (`stop`, kept in `done` so the automatic sync does not
   start it again; the eye on later clears that). An automatic watch asks first: the Mac's window
   with a native dialog, a browser with `webConfirm`. A manual one stops at once. A watched track
   that is not merging goes with it.
6. **A PR tab closed** in the window ends the manual watches it routed to its review session
   (nowhere left to send them). Manual watches whose PR has a session go on.
7. **Validation** of a new watch: a light read of the PR as the tab's account, past the cache.
   Answers: not a PR link or number, repository not found or no access, no such PR, not open
   (merged or closed: nothing to watch), already watched (the existing watch is kept).
8. **Input**: `https://github.com/owner/repo/pull/123` (anything after the number ignored),
   `owner/repo#123`, `#123` or `123` in the tab's primary repository: the tab's Repo filter (with
   the account's owner) when one is set, else the account's issue repository.
9. **Web app**: the one new channel (`prWatch:set`) is `remote`; a browser may start and stop
   watches as the window does (it confirms with `webConfirm`). Two or more accounts: the tab's
   account must be connected.
10. **Limits** (ponytail): at most 100 manual watches; the phone/API snapshot does not carry them.

## Data

`PrWatchEntry` gains `manual?`, `tabId?`, `tabName?`, `title?`, `head?`, `readyHead?`. An empty
`sessionKey` means "no owner yet". The light query reads `title headRefOid reviewDecision
mergeStateStatus` and the head commit's check rollup too (also used by `prStates`, which ignores
them).

`AppState.prWatches: PrWatchRow[]` (from `PrWatch.rows`): url, `owner/repo`, number, title,
`manual`, `tabId`, `tabName`, account, target (`{session: {key, name}}`, `{review: tabId}` or
null), last event (`{at, text}`), started, error. Small (one row per watch), so it reaches the web
app with the state.

`AutoTrack` gains `watched?: true` and `tabName?`. A tab with only watched tracks is polled
without the review-request search, with a stand-in tab (review and merge off, its name and
account from the track).

## UI

- **Pull requests view**: an eye in each row's action cell (◉ filled: watched; ◎ dimmed: not).
  Tooltip: "Watched by MasterDeck: events go to session *x*" / "… go to this tab's Review with
  Claude session" / "… go to the Review with Claude session of *tab*", "Not watched: click to
  watch". Closed and merged PRs have no eye.
- **PR popup** (from the Pull requests view): the same eye beside the state chip.
- **Review with Claude widget** (◂ Auto): a **Watched PRs** section: an **Add** field (PR link
  or number) with its error inline, and a row per watch started from this tab or belonging to a
  session of the tab's account: `repo#n`, title, where events go, the last event and when, ×.
- **Details → GitHub → Monitors**: an owned watch is listed under its session as today ("by
  MasterDeck").

## Not done

The phone/API snapshot, a watch list in Settings, choosing the target by hand, watching closed PRs.
