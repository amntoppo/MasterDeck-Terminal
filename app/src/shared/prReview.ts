/**
 * The Pull requests view's Claude panel (Review with Claude): a Claude session per PR tab in its own
 * folder, which MasterDeck briefs (CLAUDE.md: how to review) and keeps current (context.json: the
 * tab, its filters, the selected PR, the account). It reads PRs with gh and posts a review only
 * through ./post-review.sh, after the user agreed (main/prReviewDirs.ts writes the folder).
 */
import { normalizePrFilters, type PrFilters, type TeamPr } from "./teamPrs";
import { ticketRef } from "./ticket";
import { ticketSpecError } from "./ticketBuilder";

export const PR_REVIEW_NAME = "md-pr-review";

/** The review session's name: one per PR tab. */
export const prReviewName = (tab: string): string => `${PR_REVIEW_NAME}-${tab}`;

/** Why a pr-review pane spec from a browser is refused: always a tab's, else as the ticket builder's. */
export function prReviewSpecError(
  spec: { tab?: unknown; account?: unknown },
  logins: string[],
  folderAccount?: (tab: string) => string | null,
): string | null {
  if (typeof spec.tab !== "string") return "refusing a PR review without its tab";
  return ticketSpecError(spec, logins, folderAccount, "PR review");
}

/** A GitHub PR URL's owner, repository and number; null for anything else. */
export function prRef(url: unknown): { owner: string; repo: string; number: number } | null {
  if (typeof url !== "string") return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([0-9]{1,9})\/?$/.exec(url);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

/** What the view asks main to write: the tab, and the PR it has selected (main looks its facts up). */
export interface PrReviewRequest {
  tabId: string;
  /** The tab's name, for Claude's context only. */
  tab: string;
  /** The tab's account (two or more accounts). */
  account?: string;
  filters: PrFilters;
  /** The selected PR's URL, if any. */
  url?: string;
  /** Only the context changed (another PR, the filters): CLAUDE.md, the script and settings stay as written. */
  context?: boolean;
}

export interface PrReviewSelected {
  url: string;
  /** owner/name. */
  repo: string;
  number: number;
  title: string;
  author: string;
  state: TeamPr["state"];
  draft: boolean;
  branch: string;
  base: string;
  ci: TeamPr["ci"];
  reviewDecision: TeamPr["reviewDecision"];
  reviews: TeamPr["reviews"];
  requested: string[];
  labels: string[];
  additions: number;
  deletions: number;
  files: number;
  unresolvedThreads: number;
  /** The issues it closes, `owner/name#n`. */
  issues: string[];
}

export interface PrReviewContext {
  tab: string;
  account: string | null;
  filters: PrFilters;
  selected: PrReviewSelected | null;
  selectedAt: string;
}

/** context.json for a PR tab's review session: the selected PR is taken from MasterDeck's own list, never the caller. */
export function prReviewContext(req: PrReviewRequest, prs: TeamPr[], now = Date.now()): PrReviewContext {
  const ref = prRef(req.url);
  const p = ref ? prs.find((x) => x.url === req.url) : undefined;
  return {
    tab: String(req.tab ?? "").slice(0, 100),
    account: req.account ?? null,
    filters: normalizePrFilters(req.filters),
    selected:
      ref && p
        ? {
            url: p.url,
            repo: `${ref.owner}/${ref.repo}`,
            number: p.number,
            title: p.title,
            author: p.author,
            state: p.state,
            draft: p.draft,
            branch: p.headRef,
            base: p.baseRef,
            ci: p.ci,
            reviewDecision: p.reviewDecision,
            reviews: p.reviews,
            requested: p.requested,
            labels: p.labels.map((l) => l.name),
            additions: p.additions,
            deletions: p.deletions,
            files: p.files,
            unresolvedThreads: p.unresolvedThreads,
            // A ref's null repo is the primary issue repository; bare numbers (older lists) the PR's own.
            issues: p.issueRefs
              ? p.issueRefs.map((t) => ticketRef(t.repo, t.number))
              : p.issues.map((n) => `${ref.owner}/${ref.repo}#${n}`),
          }
        : null,
    selectedAt: new Date(now).toISOString(),
  };
}

/** "acme/web#123", the panel's and the prompt's name for a PR. */
export const prLabel = (url: string): string => {
  const r = prRef(url);
  return r ? `${r.owner}/${r.repo}#${r.number}` : url;
};

/** What the row's and the popup's Review with Claude types into the session. */
export const reviewPrompt = (url: string): string => `Review the selected PR, ${prLabel(url)}.`;

/** The review folder's CLAUDE.md. `me`: who the user is on GitHub (the tab's account), if known. */
export function prReviewBriefing(me: string | null): string {
  return `# MasterDeck: review pull requests with the user

You help the user review GitHub pull requests. The user sees this conversation next to MasterDeck's
**Pull requests** view${me ? ` and is \`${me}\` on GitHub` : ""}. They click a PR in the list to select it.

## context.json: the PR the user means

Re-read \`context.json\` at the start of **every** answer: the user may have picked another PR since.

- \`selected\`: the PR selected in the list (\`url\`, \`repo\`, \`number\`, \`title\`, \`author\`, \`branch\`,
  \`base\`, \`state\`, \`draft\`, \`ci\`, \`reviewDecision\`, \`reviews\`, \`requested\`, \`labels\`, size,
  \`unresolvedThreads\`, \`issues\` it closes). \`null\`: none selected; ask the user to click one, or
  use the PR they name.
- \`filters\`, \`tab\`: what the user's list shows (context only, e.g. "the failing ones").
- \`account\`: the GitHub account this session works as.

"This PR", "it", "the PR" mean \`selected\`. When it changed since your last answer, say which PR you
are now on.

## Reading a PR

\`\`\`bash
gh pr view <url> --comments        # description, reviews, comments
gh pr diff <url>                   # the change
gh pr checks <url>                 # CI
gh run view <run-id> --log-failed  # why a check failed
\`\`\`

- Read the diff before saying anything about the code. Base what you say on the diff, the checks and
  the comments, not on the title.
- When the diff is not enough (a function's callers, a whole file), read files at the PR's head:
  \`gh api repos/<owner>/<repo>/contents/<path>?ref=<branch>\` (base64), or a shallow clone into
  \`./checkouts/\` in this folder (\`gh repo clone <owner>/<repo> checkouts/<repo>-<number> -- --depth 1
  --branch <branch>\`). Never touch the user's own checkouts, never commit or push.
- Read the linked issue (\`gh issue view\`) when the PR's purpose is unclear.

## Reviewing

Look for, in this order: bugs (wrong logic, edge cases, error handling, races), security (input
checks, secrets, injection, permissions), missing or weak tests for what changed, then clarity and
consistency with the code around it. Skip style a linter would catch.

- Cite \`path:line\` (the line in the PR's head) for every point; quote the code when it helps.
- Say how sure you are when you are not; say plainly when you found nothing important.
- "Summarise": what changes and why, in a few lines, then the risky parts.
- "Is it safe to merge?": checks, reviews, unresolved threads, conflicts (\`gh pr view <url> --json
  mergeable,mergeStateStatus\`), and your own findings; answer yes / not yet / no, and why.
- "What does the CI failure mean?": the failing check's log (\`--log-failed\`), the cause, and the fix.

## Posting to GitHub: only after the user agrees

Nothing you write reaches GitHub unless the user says so. To post:

1. Write the review to a file in this folder (e.g. \`review-<number>.md\`), and inline comments, if
   any, to a JSON file (e.g. \`review-<number>.json\`): an array of
   \`{"path": "src/a.ts", "line": 42, "body": "…"}\` (\`line\` in the PR's head; add \`"start_line"\`
   for a range, \`"side": "LEFT"\` for a removed line).
2. Show the user exactly what will be posted: the PR, the event (comment, approve or request
   changes), the body and each inline comment. Ask. Post only after a clear yes to that text.
3. Post it:

\`\`\`bash
./post-review.sh --pr <selected.url> --event comment|approve|request-changes --body-file review-<number>.md [--comments-file review-<number>.json]
\`\`\`

- Add \`--dry-run\` to check the payload without posting.
- It posts one review to the PR selected in MasterDeck only (\`--pr\` must be \`selected.url\`), as
  \`account\`, and prints \`{"ok": true, "url": …}\` or why not. Give the user the URL.
- Approve or request changes only when the user asked for that event.
- This is the only way to write to GitHub here: \`gh pr review\`, \`gh pr comment\`, \`gh pr merge\` and the
  like are blocked. Never merge, close or edit a PR.

## Automated reviews

When the user switched **Automate Review** on, MasterDeck types a message starting
\`[MasterDeck auto-review]\` for each PR whose review is asked of them. That message is the user's
standing request: review the PR it names (its URL, not \`selected\`), without asking.

1. Read it as above (\`gh pr view\`, \`gh pr diff\`, \`gh pr checks\`) and review it the same way.
2. Write the review to \`auto-<number>.md\`: a short summary, then the points that matter. Put
   comments on lines in \`auto-<number>.json\` (as above). Nothing important found: say so in a line.
3. Post it at once, no question to the user:

\`\`\`bash
./post-review.sh --auto --pr <its url> --body-file auto-<number>.md [--comments-file auto-<number>.json]
\`\`\`

- It is always a comment review: never approve, never request changes, never merge. MasterDeck
  follows the PR from there (new commits come back to you as a new message).
- It posts only to a PR MasterDeck queued. If it refuses, say why in one line and stop.
- Then answer with one line: the PR, how many comments, the review's URL.

Only write files in this folder. Don't touch \`~/.claude\` or MasterDeck's own files.
`;
}
