import { describe, expect, it } from "vitest";
import {
  answersDecision,
  applyEventLine,
  decisionFor,
  requestMenu,
  requestQuestions,
  parseRequest,
  requestOver,
  requestPrompt,
  ruleText,
  ticketContext,
  type HookSessionState,
} from "./deckHooks";

// Shapes as Claude Code 2.1 sends them (captured from a probe session).
const REQ = JSON.stringify({
  id: "1790540000-123-9",
  pid: 4321,
  at: 1790540000000,
  data: {
    session_id: "4d1bc2b2-2edb-4304-91fd-6633dc9bd935",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: {
      command: "curl -sI https://example.com -o /dev/null -w '%{http_code}'",
      description: "Check HTTP status",
    },
    permission_suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "curl *" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ],
  },
});

describe("permission requests", () => {
  const r = parseRequest(REQ)!;
  it("parses the pending file", () => {
    expect(r).toMatchObject({
      id: "1790540000-123-9",
      pid: 4321,
      sessionId: "4d1bc2b2-2edb-4304-91fd-6633dc9bd935",
      tool: "Bash",
    });
    expect(parseRequest('{"id":"../x","data":{}}')).toBeNull();
    expect(parseRequest("nope")).toBeNull();
  });
  it("shows it as the card does", () => {
    expect(requestPrompt(r)).toEqual({
      title: "Bash command",
      lines: [
        "curl -sI https://example.com -o /dev/null -w '%{http_code}'",
        "Check HTTP status",
      ],
      reason: null,
      question: "Do you want to proceed?",
      options: ["Yes", "Yes, and don't ask again: Bash(curl *)", "No"],
      requestId: "1790540000-123-9",
    });
    expect(requestPrompt({ ...r, suggestions: [] }).options).toEqual([
      "Yes",
      "No",
    ]);
    expect(ruleText([{ type: "setMode", mode: "acceptEdits" }])).toBe(
      "switch to acceptEdits mode",
    );
  });
  it("answers allow, always allow (the suggested rules) and deny with a note", () => {
    const out = (d: object) => ({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d },
    });
    expect(decisionFor(r, 0)).toEqual(out({ behavior: "allow" }));
    expect(decisionFor(r, 1)).toEqual(
      out({ behavior: "allow", updatedPermissions: r.suggestions }),
    );
    expect(decisionFor(r, 2, " use the staging URL ")).toEqual(
      out({ behavior: "deny", message: "use the staging URL" }),
    );
    expect(decisionFor({ ...r, suggestions: [] }, 1)).toEqual(
      out({ behavior: "deny", message: "Denied from MasterDeck." }),
    );
    expect(decisionFor(r, 3)).toBeNull();
  });
  it("is over once answered in the terminal", () => {
    const at = r.at;
    expect(requestOver(r, at + 3000, false, false, null)).toBe(false); // claude agents has not caught up yet
    expect(requestOver(r, at + 3000, true, true, null)).toBe(false);
    expect(requestOver(r, at + 9000, false, true, null)).toBe(true); // was waiting, is not any more
    expect(requestOver(r, at + 25_000, false, false, null)).toBe(true);
    expect(requestOver(r, at + 3000, true, true, at + 2000)).toBe(true); // its turn ended
  });
});

describe("events", () => {
  const sid = "4d1bc2b2-2edb-4304-91fd-6633dc9bd935";
  const line = (event: string, data: object, at = 1000) =>
    JSON.stringify({ at, event, data: { session_id: sid, ...data } });
  it("tracks notices, API errors, compactions and folders per session", () => {
    const st: Record<string, HookSessionState> = {};
    expect(
      applyEventLine(
        st,
        line("Notification", {
          notification_type: "permission_prompt",
          message: "Claude needs your permission",
        }),
      ),
    ).toBe(sid);
    expect(st[sid].notice).toEqual({
      type: "permission_prompt",
      message: "Claude needs your permission",
      at: 1000,
    });
    applyEventLine(
      st,
      line(
        "StopFailure",
        { error_type: "rate_limit", error_message: "Rate limit exceeded" },
        2000,
      ),
    );
    expect(st[sid].failure).toEqual({
      type: "rate_limit",
      message: "Rate limit exceeded",
      at: 2000,
    });
    applyEventLine(st, line("PreCompact", { trigger: "auto" }, 3000));
    expect(st[sid].compacting).toBe(true);
    applyEventLine(st, line("PostCompact", { trigger: "auto" }, 4000));
    expect(st[sid]).toMatchObject({ compacting: false, compactedAt: 4000 });
    applyEventLine(
      st,
      line(
        "CwdChanged",
        { cwd: "/w/repo/.claude/worktrees/x", previous_cwd: "/w/repo" },
        5000,
      ),
    );
    expect(st[sid].cwd).toBe("/w/repo/.claude/worktrees/x");
    applyEventLine(st, line("Stop", {}, 6000));
    expect(st[sid]).toMatchObject({ failure: null, stoppedAt: 6000 });
    expect(applyEventLine(st, "garbage")).toBeNull();
    expect(
      applyEventLine(st, JSON.stringify({ event: "Stop", data: {} })),
    ).toBeNull();
  });
});

describe("ticketContext", () => {
  it("names the ticket and the newest earlier summaries", () => {
    const c = ticketContext(
      {
        label: "#989",
        title: "Ship the Expo app",
        url: "https://github.com/o/r/issues/989",
      },
      [{ name: "989-a", at: Date.UTC(2026, 8, 20), text: "Did X." }],
    ) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(c.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(c.hookSpecificOutput.additionalContext).toContain(
      "This session works on #989 (Ship the Expo app).",
    );
    expect(c.hookSpecificOutput.additionalContext).toContain(
      "### 989-a (2026-09-20)\nDid X.",
    );
  });
});

describe("AskUserQuestion requests", () => {
  const ask = parseRequest(
    JSON.stringify({
      id: "q1",
      pid: 1,
      at: 5,
      data: {
        session_id: "s1",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Which reports?",
              header: "Scope",
              options: [
                { label: "All", description: "every report" },
                { label: "Hitting only" },
              ],
              multiSelect: false,
            },
            {
              question: "Pill colours?",
              header: "Colour",
              options: [{ label: "Amber" }, { label: "Blue" }],
              multiSelect: true,
            },
          ],
        },
      },
    }),
  )!;
  it("reads the questions and their options", () => {
    const qs = requestQuestions(ask)!;
    expect(qs).toHaveLength(2);
    expect(qs[0]).toEqual({
      question: "Which reports?",
      header: "Scope",
      multiSelect: false,
      options: [
        { label: "All", description: "every report" },
        { label: "Hitting only", description: "" },
      ],
    });
    expect(qs[1].multiSelect).toBe(true);
    const menu = requestMenu(ask);
    expect(menu.asked?.requestId).toBe("q1");
    expect(menu.permission).toBeUndefined();
    expect(menu.tabs.map((t) => t.label)).toEqual(["Scope", "Colour"]);
  });
  it("answers with updatedInput.answers, only when every question has one", () => {
    expect(answersDecision(ask, { "Which reports?": "All" })).toBeNull();
    const d = answersDecision(ask, {
      "Which reports?": "All",
      "Pill colours?": "Amber, Blue",
    }) as {
      hookSpecificOutput: {
        decision: {
          behavior: string;
          updatedInput: { answers: object; questions: unknown[] };
        };
      };
    };
    expect(d.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(d.hookSpecificOutput.decision.updatedInput.answers).toEqual({
      "Which reports?": "All",
      "Pill colours?": "Amber, Blue",
    });
    expect(d.hookSpecificOutput.decision.updatedInput.questions).toHaveLength(
      2,
    );
  });
  it("leaves other tools as permissions", () => {
    const bash = { ...ask, tool: "Bash", input: { command: "ls" } };
    expect(requestQuestions(bash)).toBeNull();
    expect(requestMenu(bash).permission?.title).toBe("Bash command");
    expect(answersDecision(bash, {})).toBeNull();
  });
});
