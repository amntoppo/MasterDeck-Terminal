import { installPrompt } from "./install";
import type { PaneSpec } from "./types";

export interface PaneCommand {
  file: string;
  args: string[];
  cwd?: string;
}

/** The process a pane runs. `shell` is $SHELL (unused on Windows); `claude` is the resolved binary. */
export function paneCommand(
  spec: PaneSpec,
  platform: string,
  shell: string | undefined,
  claude = "claude",
): PaneCommand {
  const win = platform === "win32";
  if (spec.kind === "attach") {
    return { file: claude, args: ["attach", spec.bgId] };
  }
  if (spec.kind === "installer")
    return { file: claude, args: [installPrompt(spec.tools, platform)] };
  // Its own folder (set by the pane manager); only project settings, so the user's hooks (workflow
  // steps, MasterDeck's) don't reach it; edits in its folder (draft.json) without asking.
  // The Board's ticket session: its own folder too; project settings allow its create command.
  if (spec.kind === "ticket-builder")
    return {
      file: claude,
      args: [
        ...(spec.resume ? ["--continue"] : []),
        "-n",
        "md-ticket-builder",
        "--setting-sources",
        "project,local",
        "--permission-mode",
        "acceptEdits",
        ...(spec.prompt && !spec.prompt.startsWith("-") ? [spec.prompt] : []),
      ],
    };
  if (spec.kind === "builder")
    return {
      file: claude,
      args: [
        ...(spec.resume ? ["--continue"] : []),
        "-n",
        "md-workflow-builder",
        "--setting-sources",
        "project,local",
        "--permission-mode",
        "acceptEdits",
      ],
    };
  if (spec.kind === "gh-login")
    return { file: win ? "gh.exe" : "gh", args: ["auth", "login", "--hostname", "github.com", "--web"] };
  if (win) return { file: "powershell.exe", args: ["-NoLogo"], cwd: spec.cwd };
  return { file: shell || "/bin/zsh", args: ["-l"], cwd: spec.cwd };
}

/** A background id is 8 hex characters; anything else is refused before it reaches a shell. */
export function isSafeBgId(id: string): boolean {
  return /^[0-9a-f]{8}$/i.test(id);
}
