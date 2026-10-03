import { describe, expect, it } from "vitest";
import { boardFor, ticketDefaults } from "./NewTicket";
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
