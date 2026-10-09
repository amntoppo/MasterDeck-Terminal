/**
 * The Board's ticket session (Create with Claude): a Claude session in its own folder that writes
 * and creates tickets on the board. MasterDeck briefs it (CLAUDE.md: the boards, their columns and
 * sprints, the repos, the people) and says where the + was clicked (context.json: the column, the
 * board, the tab's filters, the sprint shown). It creates tickets with ./create-ticket.sh (MasterDeck
 * creates the ticket; same flags as before) and logs each one so the Board refreshes.
 */
import { isMulti } from "./accounts";
import type { AppConfig } from "./appConfig";
import { boardless, reposOf } from "./derivedBoard";
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
  /** The Board tab's account. With two or more accounts and no board of its own: only its repositories, and no board (never another account's). */
  account?: string | null,
): string {
  const loose = !!account && isMulti(cfg) && cfg.accounts.some((a) => a.login === account) && boardless(account, cfg);
  const repos = loose ? reposOf(account, cfg) : cfg.repos;
  const boards = (loose ? [] : cfg.projects)
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
  const primary = repos[0] ?? `${cfg.owner}/${cfg.issueRepo}`;
  return `# MasterDeck: tickets for the board

You write and create GitHub issues ("tickets") on the team's project board, from what the user
asks. The user sees this conversation next to MasterDeck's Board, and clicked **+** on a column
(or **Create with Claude** in the New ticket dialog) to get here.

## The settings bar: what every ticket gets

Below this chat the user has a settings bar. Its values are \`settings\` in \`context.json\` (re-read
it before each ticket: the user can change it at any time, and the change applies to the next ticket):
\`repo\`, \`project\` (the board, owner/number), \`status\` (the column), \`assignees\`, \`labels\`,
\`milestone\` and \`sprint\` (a title, \`@current\`, or empty for no sprint).

- **MasterDeck creates every ticket with exactly these values**, whatever flags you pass. Leave out
  \`--repo\`, \`--project\`, \`--status\`, \`--assignee\`, \`--label\`, \`--milestone\` and \`--sprint\`.
- When you show a plan, show these values (they are what the ticket will get).
- When the user asks in the chat for something else (another person, column, repo, label, sprint…),
  don't pretend to do it: say the settings bar's value applies, and that they can change it in the bar
  below the chat (it applies to the next ticket). Then go on once they have.
- An empty \`status\` and \`project\`: this account has no GitHub board; the ticket goes on no board, and
  MasterDeck's Board shows it in Todo by itself.

Also in \`context.json\`, for context only: \`filters\` (the Board tab's filters), \`status\`/\`sprint\`
(where the + was clicked), and \`draft\` (what they had typed in the dialog: title, body…), if they
came from it.

## Creating a ticket

\`\`\`bash
./create-ticket.sh --title "<title>" --body-file <file.md>
\`\`\`

- Write the description to a file in this folder first (e.g. \`ticket-1.md\`), then pass it.
- Add \`--dry-run\` to check everything (repo, board, status) without creating anything.
- It prints JSON: \`{"ok": true, "url", "number", "status", "sprint", "applied"}\` (\`applied\`: the
  values used), or an error. Give the user the URL. When it has \`overridden\`/\`note\`, you passed a flag
  the bar replaced: tell the user which value was used.
- It creates the issue, puts it on the board in that column, and in the sprint. MasterDeck's
  Board refreshes by itself.
- Before creating several, or anything the user didn't clearly ask for, show them the plan
  (titles, and the bar's repo and assignees) and create after they agree. One clear request: just create it.
- Don't close, edit or delete existing issues. Read them if useful (\`gh issue view\`, \`gh issue list\`,
  \`gh search issues\`), e.g. to avoid a duplicate or to link a related one (\`Related: #123\`).

## A good ticket

- **Title**: short and specific, what changes, not how ("Report sharing fails for B2B orgs").
- **Body** (Markdown): a line of context (who is affected, where), then what to do or what's
  wrong (steps to reproduce, expected vs actual for a bug), then **Acceptance criteria** as a
  checklist. Add links, screenshots paths or logs the user gave. Keep it tight.
- The repo is the settings bar's; when the work clearly belongs in another, say so (default: \`${primary}\`).
- Split a big request into a few tickets when they can be done and reviewed separately.

## The board

Boards:

${boards || (loose ? `- (none: \`${account}\` has no GitHub board; create without \`--project\`, \`--status\` and \`--sprint\`)` : "- (none configured)")}

Open sprints:

${sprintList}

Repos (owner/name; the first is the default):

${repos.map((r) => `- \`${r}\``).join("\n") || `- \`${primary}\``}

People on the board (for assignees):${me ? ` you are talking to \`${me}\`.` : ""}

${people.map((p) => `- \`${p}\``).join("\n") || "- (nobody yet)"}

Labels and milestones differ per repo: \`gh label list -R <owner/name>\`.

Only write files in this folder. Don't touch \`~/.claude\` or MasterDeck's own files.
`;
}
