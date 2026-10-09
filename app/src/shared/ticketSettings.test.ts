import { describe, expect, it } from "vitest";
import { enforceSettings, readSettings, settingsSummary } from "./ticketSettings";

const bar = { repo: "acme/web", project: "acme/1", status: "In Dev", assignees: ["Ann"], labels: [], milestone: "v1", sprint: "", sprintField: "Sprint" };

describe("ticket settings", () => {
  it("reads only a well-formed bar, trimmed and deduplicated", () => {
    expect(readSettings(null)).toBeNull();
    expect(readSettings({ repo: "../x" })).toBeNull();
    expect(readSettings({ ...bar, assignees: ["a", "a", " b ", 3], labels: "x" })).toMatchObject({ assignees: ["a", "b"], labels: [] });
  });
  it("replaces every field; only differing flags the session passed count as overridden", () => {
    const { req, overridden } = enforceSettings({ title: "T", assignees: ["ann"], labels: ["bug"], sprint: "@current", sprintField: "It" }, bar);
    expect(req).toMatchObject({ title: "T", repo: "acme/web", project: "acme/1", status: "In Dev", assignees: ["Ann"], labels: [], milestone: "v1" });
    expect(req.sprint).toBeUndefined();
    expect(req.sprintField).toBeUndefined();
    expect(overridden).toEqual([
      { field: "labels", asked: "bug", used: "" },
      { field: "sprint", asked: "@current", used: "" },
    ]);
  });
  it("a board-less bar sends no board, and a board named anyway is listed", () => {
    const { req, overridden } = enforceSettings({ project: "acme/9" }, { ...bar, project: "", status: "" });
    expect(req.project).toBeUndefined();
    expect(req.status).toBeUndefined();
    expect(overridden.map((o) => o.field)).toEqual(["project"]);
  });
  it("summarises each field, collapsed", () => {
    expect(settingsSummary({ ...bar, sprint: "@current" }, "Product")).toEqual(["web", "@Ann", "In Dev (Product)", "current sprint", "no labels", "v1"]);
    expect(settingsSummary({ ...bar, project: "" })).toEqual(["web", "@Ann", "no board", "no labels", "v1"]);
  });
});
