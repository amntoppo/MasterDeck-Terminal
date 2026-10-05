/**
 * The Board's ticket session (Create with Claude): a Claude session in its own folder that writes
 * and creates tickets on the board. MasterDeck briefs it (CLAUDE.md: the boards, their columns and
 * sprints, the repos, the people) and says where the + was clicked (context.json: the column, the
 * board, the tab's filters, the sprint shown). It creates tickets with ./create-ticket.sh (MasterDeck
 * creates the ticket; same flags as before) and logs each one so the Board refreshes.
 */
import type { AppConfig } from "./appConfig";
import type { Sprint } from "./types";

export const TICKET_BUILDER_NAME = "md-ticket-builder";

/** A Board tab id a ticket builder may be named and foldered by (two or more accounts: one per tab). */
export const TICKET_TAB = /^[A-Za-z0-9_-]{1,64}$/;

/** The ticket builder's session name: one shared (one account), or one per Board tab. */
export const ticketBuilderName = (tab?: string): string =>
  tab ? `${TICKET_BUILDER_NAME}-${tab}` : TICKET_BUILDER_NAME;

/** Why a ticket-builder pane spec from a browser is refused (a bad tab id, an account not connected); null if fine. */
export function ticketSpecError(
  spec: { tab?: unknown; account?: unknown },
  logins: string[],
  /** The account the tab's folder already names (its context.json), if any. */
  folderAccount?: (tab: string) => string | null,
): string | null {
  const low = (s: string) => s.toLowerCase();
  if (spec.tab !== undefined && (typeof spec.tab !== "string" || !TICKET_TAB.test(spec.tab)))
    return "refusing a ticket builder with a bad tab id";
  if (spec.account === undefined) return null;
  if (typeof spec.account !== "string" || !logins.some((l) => low(l) === low(spec.account as string)))
    return "refusing a ticket builder as an account that is not connected";
  const held = typeof spec.tab === "string" ? folderAccount?.(spec.tab) : null;
  if (held && low(held) !== low(spec.account))
    return `refusing a ticket builder as ${spec.account}: that tab's session works as ${held}`;
  return null;
}

export function ticketContext(
  cfg: AppConfig,
  sprints: Sprint[],
  people: string[],
  me: string | null,
): string {
  const boards = cfg.projects
    .map(
      (p) =>
        `- \`${p.owner}/${p.number}\` (${p.title}): columns, in order: ${p.columns.map((c) => `\`${c}\``).join(", ")}. Sprint field: \`${p.sprintField || "Sprint"}\`.`,
    )
    .join("\n");
  const open = sprints.filter((s) => !s.completed);
  const sprintList = open.length
    ? open
        .map(
          (s) => `- \`${s.title}\` (from ${s.startDate}, ${s.duration} days)`,
        )
        .join("\n")
    : "- (none)";
  const primary = cfg.repos[0] ?? `${cfg.owner}/${cfg.issueRepo}`;
  return `# MasterDeck: tickets for the board

You write and create GitHub issues ("tickets") on the team's project board, from what the user
asks. The user sees this conversation next to MasterDeck's Board, and clicked **+** on a column
(or **Create with Claude** in the New ticket dialog) to get here.

## Where they clicked

\`context.json\` says it (re-read it before each ticket: the user may click + on another column):

- \`status\`: the column; new tickets go there unless the user says otherwise.
- \`project\`: the board (owner/number) it belongs to.
- An empty \`status\` and \`project\`: this account has no GitHub board. Create the issue without
  \`--project\`, \`--status\` and \`--sprint\`; MasterDeck's Board shows it in Todo by itself.
- \`filters\`: the Board tab's filters: \`assignees\` (logins; \`(unassigned)\` means nobody), \`labels\`,
  \`milestone\`, \`repos\` (owner/name), \`projects\`. Use them as defaults: assign the people and put
  the labels and milestone the tab filters to, so the new ticket shows in the view they're looking at.
- \`sprint\`: the sprint the Board shows: a title, \`@current\`, or \`none\` (no sprint).
- \`draft\`: what they had typed in the dialog (title, body, repo…), if they came from it.

## Creating a ticket

\`\`\`bash
./create-ticket.sh --repo <owner/name> --title "<title>" --body-file <file.md> \\
  --project <owner/number> --status "<column>" [--assignee login1,login2] [--label L]... \\
  [--milestone "<title>"] [--sprint "<title>|@current"] [--sprint-field <field>]
\`\`\`

- Write the description to a file in this folder first (e.g. \`ticket-1.md\`), then pass it.
- Add \`--dry-run\` to check everything (repo, board, status) without creating anything.
- It prints JSON: \`{"ok": true, "url", "number", "status", "sprint"}\`, or an error. Give the user the URL.
- It creates the issue, puts it on the board in that column, and in the sprint. MasterDeck's
  Board refreshes by itself.
- Before creating several, or anything the user didn't clearly ask for, show them the plan
  (titles, repos, assignees) and create after they agree. One clear request: just create it.
- Don't close, edit or delete existing issues. Read them if useful (\`gh issue view\`, \`gh issue list\`,
  \`gh search issues\`), e.g. to avoid a duplicate or to link a related one (\`Related: #123\`).

## A good ticket

- **Title**: short and specific, what changes, not how ("Report sharing fails for B2B orgs").
- **Body** (Markdown): a line of context (who is affected, where), then what to do or what's
  wrong (steps to reproduce, expected vs actual for a bug), then **Acceptance criteria** as a
  checklist. Add links, screenshots paths or logs the user gave. Keep it tight.
- Pick the repo the work happens in; when unsure, ask (default: \`${primary}\`).
- Split a big request into a few tickets when they can be done and reviewed separately.

## The board

Boards:

${boards || "- (none configured)"}

Open sprints:

${sprintList}

Repos (owner/name; the first is the default):

${cfg.repos.map((r) => `- \`${r}\``).join("\n") || `- \`${primary}\``}

People on the board (for assignees):${me ? ` you are talking to \`${me}\`.` : ""}

${people.map((p) => `- \`${p}\``).join("\n") || "- (nobody yet)"}

Labels and milestones differ per repo: \`gh label list -R <owner/name>\`.

Only write files in this folder. Don't touch \`~/.claude\` or MasterDeck's own files.
`;
}
