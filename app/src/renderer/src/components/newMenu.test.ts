import { describe, expect, it } from "vitest";
import { nextName } from "./NewMenu";

describe("nextName", () => {
  it("numbers after the folder, past the ones taken", () => {
    expect(
      nextName("gamerun-app", ["gamerun-app-54", "gamerun-app-3", "other-9"]),
    ).toBe("gamerun-app-55");
    expect(nextName("my repo!", [])).toBe("my-repo-1");
    expect(nextName(".hidden", [])).toBe("hidden-1");
  });
});
