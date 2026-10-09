/**
 * Create with Claude's settings bar (#68): the repo, board, status, sprint, assignees, labels and
 * milestone every ticket of the Board's Claude session is created with. The bar writes them to the
 * ticket folder's context.json (`settings`); MasterDeck's create pump applies them to each
 * ./create-ticket.sh request, so they win over whatever the session passed, and the answer says
 * which values it replaced. Claude is told the same (the bar's value applies; change it there).
 */

/** What the bar enforces. Empty means none: no milestone, no sprint, nobody, no label. */
export interface TicketSettings {
  repo: string;
  /** The board (owner/number); "" on an account with no board. */
  project: string;
  status: string;
  assignees: string[];
  labels: string[];
  milestone: string;
  /** A sprint title, "@current", or "" for no sprint. */
  sprint: string;
  sprintField: string;
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The settings a context.json (written by a window or a web tab) holds, checked and trimmed; null if none. */
export function readSettings(raw: unknown): TicketSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const list = (v: unknown, n: number) =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, n)))].slice(0, 20)
      : [];
  const repo = str(o.repo, 140);
  if (!REPO.test(repo)) return null;
  return {
    repo,
    project: str(o.project, 140),
    status: str(o.status, 100),
    assignees: list(o.assignees, 100),
    labels: list(o.labels, 100),
    milestone: str(o.milestone, 200),
    sprint: str(o.sprint, 200),
    sprintField: str(o.sprintField, 100),
  };
}

/** The create flags a request can carry, as parseCreateArgs reads them. */
export interface CreateFields {
  repo?: string;
  project?: string;
  status?: string;
  assignees?: string[];
  labels?: string[];
  milestone?: string;
  sprint?: string;
  sprintField?: string;
}

/** A value the session asked for that the bar replaced. */
export interface Overridden {
  field: "repo" | "project" | "status" | "assignees" | "labels" | "milestone" | "sprint";
  asked: string;
  used: string;
}

const joinList = (l: string[] | undefined) => (l ?? []).join(", ");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.some((y) => same(x, y)));

/**
 * A request with the bar's values in place of the session's. A flag the session left out is not an
 * override; one that differs is listed, so the answer can say which value was used.
 */
export function enforceSettings<T extends CreateFields>(
  req: T,
  s: TicketSettings,
): { req: T & CreateFields; overridden: Overridden[] } {
  const overridden: Overridden[] = [];
  const one = (field: "repo" | "project" | "status" | "milestone" | "sprint", used: string) => {
    const asked = req[field];
    if (asked !== undefined && asked.trim() && !same(asked.trim(), used)) overridden.push({ field, asked, used });
  };
  const many = (field: "assignees" | "labels", used: string[]) => {
    const asked = req[field];
    if (asked !== undefined && asked.length && !sameList(asked, used))
      overridden.push({ field, asked: joinList(asked), used: joinList(used) });
  };
  one("repo", s.repo);
  one("project", s.project);
  one("status", s.status);
  many("assignees", s.assignees);
  many("labels", s.labels);
  one("milestone", s.milestone);
  one("sprint", s.sprint);
  return {
    req: {
      ...req,
      repo: s.repo,
      project: s.project || undefined,
      status: s.status || undefined,
      assignees: s.assignees,
      labels: s.labels,
      milestone: s.milestone || undefined,
      sprint: s.sprint || undefined,
      sprintField: s.sprint ? s.sprintField || req.sprintField : undefined,
    },
    overridden,
  };
}

/** How a sprint value reads: "current sprint", "no sprint", or its title. */
export const sprintLabel = (sprint: string): string =>
  sprint === "@current" ? "current sprint" : sprint ? sprint : "no sprint";

/** The bar's one-line summary, collapsed: repo · people · status · sprint · labels · milestone. */
export function settingsSummary(s: TicketSettings, boardTitle?: string): string[] {
  return [
    s.repo.split("/")[1] ?? s.repo,
    s.assignees.length ? s.assignees.map((a) => `@${a}`).join(", ") : "unassigned",
    ...(s.project ? [`${s.status || "no status"}${boardTitle ? ` (${boardTitle})` : ""}`, sprintLabel(s.sprint)] : ["no board"]),
    s.labels.length ? s.labels.join(", ") : "no labels",
    s.milestone || "no milestone",
  ];
}

/** One line for each replaced value, for the session to tell the user. */
export const overrideNote = (o: Overridden[]): string =>
  o.map((x) => `${x.field}: asked ${x.asked || "(none)"}, used ${x.used || "(none)"} (the settings bar)`).join("; ");
