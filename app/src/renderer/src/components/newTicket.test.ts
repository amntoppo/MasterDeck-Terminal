import { describe, expect, it } from "vitest";
import { boardFor, claudeHandoff, claudePrompt, ticketDefaults, ticketRequest } from "./NewTicket";
import { paneCommand } from "@shared/paneCommand";
import { ticketContext } from "@shared/ticketBuilder";
import { defaultFilters, UNASSIGNED } from "@shared/boardFilter";
import type { AppState } from "@shared/types";
import { parseConfig } from "@shared/appConfig";

const cfg = {
  owner: "Org",
  issueRepo: "Main",
  repos: ["Org/Main", "Org/app"],
  columns: ["Todo", "In Dev", "Done"],
  sprintField: "Sprint",
  projects: [
    {
      owner: "Org",
      number: 1,
      title: "Product",
      columns: ["Todo", "In Dev", "Done"],
      sprintField: "Sprint",
    },
    {
      owner: "Org",
      number: 2,
      title: "Ops",
      columns: ["Backlog", "In Dev"],
      sprintField: "Iteration",
    },
  ],
};
const state = {
  config: cfg,
  me: "aman",
  board: null,
  sprints: [],
} as unknown as AppState;

describe("new ticket", () => {
  it("goes on the board the tab filters to, else the one with the column", () => {
    const f = defaultFilters("aman");
    expect(boardFor(state, "Backlog", f)).toBe("Org/2");
    expect(boardFor(state, "In Dev", f)).toBe("Org/1");
    expect(boardFor(state, "In Dev", { ...f, projects: ["Org/2"] })).toBe(
      "Org/2",
    );
  });
  it("takes its defaults from the column, the filters and the sprint shown", () => {
    const f = {
      ...defaultFilters("aman"),
      assignees: ["ravi", UNASSIGNED],
      labels: ["bug"],
      milestone: "v2",
      repos: ["Org/app"],
    };
    const t = ticketDefaults(state, {
      status: "Backlog",
      project: "Org/2",
      filters: f,
      sprint: "@current",
      tab: "Mine",
    });
    expect(t).toMatchObject({
      repo: "Org/app",
      status: "Backlog",
      project: "Org/2",
      assignees: ["ravi"],
      labels: ["bug"],
      milestone: "v2",
      sprint: "@current",
      sprintField: "Iteration",
    });
    const none = ticketDefaults(state, {
      status: "Todo",
      project: "Org/1",
      filters: defaultFilters(null),
      sprint: "none",
      tab: "All",
    });
    expect(none).toMatchObject({
      repo: "Org/Main",
      assignees: ["aman"],
      sprint: "",
    });
  });
  it("briefs the Claude session and runs it on its own", () => {
    const md = ticketContext(
      cfg as never,
      [
        {
          id: "i",
          title: "Sprint 6",
          startDate: "2026-09-21",
          duration: 14,
          completed: false,
        } as never,
      ],
      ["aman", "ravi"],
      "aman",
    );
    expect(md).toContain("./create-ticket.sh --repo");
    expect(md).toContain(
      "`Org/2` (Ops): columns, in order: `Backlog`, `In Dev`. Sprint field: `Iteration`.",
    );
    expect(md).toContain("`Sprint 6`");
    expect(
      paneCommand(
        { kind: "ticket-builder", resume: false, prompt: "Create this ticket" },
        "darwin",
        "/bin/zsh",
        "claude",
      ).args,
    ).toEqual([
      "-n",
      "md-ticket-builder",
      "--setting-sources",
      "project,local",
      "--permission-mode",
      "acceptEdits",
      "Create this ticket",
    ]);
  });
});

describe("a new ticket from the repository view", () => {
  const ctx = (repos: string[]) => ({ status: "Todo", project: "Org/1", filters: { ...defaultFilters("aman"), repos }, sprint: "@current", tab: "Mine" });
  it("is created in the picked repository; with several picked, the first", () => {
    expect(ticketDefaults(state, ctx(["Org/app"])).repo).toBe("Org/app");
    expect(ticketDefaults(state, ctx(["Org/app", "Org/Main"])).repo).toBe("Org/app");
    expect(ticketDefaults(state, ctx([])).repo).toBe("Org/Main"); // nothing picked: the primary, as before
  });
  it("still goes on the board, in the column and sprint the context names", () => {
    expect(ticketDefaults(state, ctx(["Org/app"]))).toMatchObject({ project: "Org/1", status: "Todo", sprint: "@current", sprintField: "Sprint" });
    expect(ticketRequest(ticketDefaults(state, ctx(["Org/app"])), false, null)).toMatchObject({ repo: "Org/app", project: "Org/1", status: "Todo" });
  });
  it("with two or more accounts, only a repository of the tab's account counts", () => {
    const two = {
      ...state,
      me: "alice",
      config: parseConfig({
        accounts: [
          { login: "alice", primary: true, owner: "acme", issueRepo: "tracker", repos: ["acme/tracker", "acme/api"], projects: [{ owner: "acme", number: 1, columns: ["Todo", "In Dev"] }] },
          { login: "bob-work", owner: "globex", issueRepo: "app", repos: ["globex/app"], projects: [] },
        ],
      }),
    } as unknown as AppState;
    const of = (repos: string[]) => ticketDefaults(two, { ...ctx(repos), project: "acme/1", account: "alice" }).repo;
    expect(of(["globex/app", "ACME/api"])).toBe("ACME/api");
    expect(of(["globex/app"])).toBe("acme/tracker");
  });
});

describe("new ticket per account", () => {
  const two = {
    ...state,
    me: "alice",
    config: parseConfig({
      accounts: [
        { login: "alice", primary: true, owner: "acme", issueRepo: "tracker", repos: ["acme/tracker"], projects: [{ owner: "acme", number: 1, columns: ["Todo", "In Dev"] }] },
        { login: "bob-work", owner: "globex", issueRepo: "app", repos: ["globex/app"], projects: [{ owner: "globex", number: 7, columns: ["Backlog", "In Dev"] }] },
      ],
    }),
  } as unknown as AppState;
  it("a tab of another account: its board, its repo, its login", () => {
    expect(boardFor(two, "In Dev", defaultFilters(null), "bob-work")).toBe("globex/7");
    expect(boardFor(two, "In Dev", defaultFilters(null))).toBe("acme/1");
    const t = ticketDefaults(two, { status: "Backlog", project: "globex/7", filters: defaultFilters(null), sprint: "@current", tab: "Mine", account: "bob-work" });
    expect([t.repo, t.assignees]).toEqual(["globex/app", ["bob-work"]]);
  });
});

describe("Create with Claude from the dialog", () => {
  it("one account: always offered, plain label", () => {
    expect(claudeHandoff(false, null, undefined)).toEqual({ label: "Create with Claude", blocked: null });
  });
  it("several: labelled with the tab's account; blocked (with a note) when the pick is another account", () => {
    expect(claudeHandoff(true, "alice", "alice")).toEqual({ label: "Create with Claude as @alice", blocked: null });
    expect(claudeHandoff(true, "Alice", "alice").blocked).toBeNull();
    expect(claudeHandoff(true, "bob-work", "alice")).toEqual({
      label: "Create with Claude as @alice",
      blocked: "Create with Claude runs on this tab's account; switch to a @bob-work tab to use it",
    });
  });
});

describe("a ticket for an account with no board", () => {
  const t = { repo: "Org/Main", title: "T", body: "B", project: "Org/1", status: "Todo", assignees: ["alice"], labels: ["bug"], milestone: "", sprint: "@current", sprintField: "Sprint" };
  it("sends no board step", () => {
    expect(ticketRequest(t, true, null)).toEqual({ ...t, project: "", status: "", sprint: "", account: undefined });
    expect(ticketRequest(t, true, "bob-work")).toMatchObject({ repo: "Org/Main", title: "T", assignees: ["alice"], project: "", status: "", sprint: "", account: "bob-work" });
  });
  it("with a board it is what the dialog always sent", () => {
    expect(ticketRequest(t, false, "alice")).toEqual({ ...t, account: "alice" });
    expect(ticketRequest(t, false, null)).toEqual({ ...t, account: undefined });
  });
});

describe("Create with Claude from the dialog", () => {
  const d = { title: " Fix login ", body: "Steps:\n1. open" } as never;
  it("names the column; without a board it names none", () => {
    expect(claudePrompt("In Dev", d)).toBe("Write this ticket for In Dev: Fix login. Steps: 1. open (the rest of what I picked is in context.json's draft). Show it to me first; create it once I say so.");
    expect(claudePrompt("", d)).toBe("Write this ticket: Fix login. Steps: 1. open (the rest of what I picked is in context.json's draft). Show it to me first; create it once I say so.");
    expect(claudePrompt("Todo", { title: "T", body: " " } as never)).toBe("Write this ticket for Todo: T (the rest of what I picked is in context.json's draft). Show it to me first; create it once I say so.");
  });
  it("nothing typed: no prompt", () => {
    expect(claudePrompt("Todo", undefined)).toBeUndefined();
    expect(claudePrompt("Todo", { title: " ", body: "" } as never)).toBeUndefined();
  });
  it("a tab whose account has no board: only that account's repos, and no board to fall back on", () => {
    const acct = (login: string, owner: string, repos: string[], projects: unknown[], primary = false) => ({
      login, name: login, email: `${login}@example.test`, owner, ownerType: "organization", issueRepo: repos[0].split("/")[1], repos, projects, ...(primary ? { primary: true } : {}),
    });
    const two = parseConfig({
      owner: "acme", issueRepo: "tracker",
      accounts: [acct("alice", "acme", ["acme/tracker", "acme/api"], [{ owner: "acme", number: 1, title: "Delivery", columns: ["Todo"] }], true), acct("bob-work", "globex", ["globex/app", "globex/web"], [])],
    });
    const loose = ticketContext(two, [], [], "bob-work", "bob-work");
    const repoList = (md: string) => md.split("Repos (owner/name; the first is the default):")[1].split("People on the board")[0];
    expect(repoList(loose)).toBe("\n\n- `globex/app`\n- `globex/web`\n\n");
    expect(loose).toContain("(default: `globex/app`)");
    expect(loose).not.toContain("acme/");
    expect(loose).toContain("- (none: `bob-work` has no GitHub board; create without `--project`, `--status` and `--sprint`)");
    // A tab whose account has a board, and no account at all: every word as before.
    const all = ticketContext(two, [], [], "alice");
    expect(ticketContext(two, [], [], "alice", "alice")).toBe(all);
    expect(repoList(all)).toContain("- `globex/app`");
    expect(all).toContain("- `acme/1` (Delivery)");
    // One account (no accounts list) with no board: the account is not a tab's, nothing changes.
    const bare = parseConfig({ owner: "acme", issueRepo: "tracker" });
    expect(ticketContext(bare, [], [], null, "alice")).toBe(ticketContext(bare, [], [], null));
    expect(ticketContext(two, [], [], null, "mallory")).toBe(ticketContext(two, [], [], null));
  });
  it("the brief says what an empty status means", () => {
    expect(ticketContext(cfg as never, [], [], null)).toContain("An empty `status` and `project`: this account has no GitHub board");
  });
});
