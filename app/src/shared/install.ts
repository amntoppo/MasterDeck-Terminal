/**
 * Onboarding's installs: the command that installs Claude Code itself, and the instructions a
 * Claude session gets to install the other tools MasterDeck uses.
 */

export const CLAUDE_INSTALL: Record<'unix' | 'win', { shell: string; command: string }> = {
  unix: { shell: 'Terminal', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
  win: { shell: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' },
}

export function claudeInstall(platform: string): { shell: string; command: string } {
  return platform === 'win32' ? CLAUDE_INSTALL.win : CLAUDE_INSTALL.unix
}

/** The tools a Claude session can install, with how each is checked. Claude Code itself is not one. */
export const INSTALLABLE: Record<string, { name: string; check: string; brew: string; winget: string }> = {
  gh: { name: 'GitHub CLI (gh)', check: 'gh --version', brew: 'gh', winget: 'GitHub.cli' },
  python: { name: 'Python 3', check: 'python3 --version', brew: 'python', winget: 'Python.Python.3.12' },
  git: { name: 'git', check: 'git --version', brew: 'git', winget: 'Git.Git' },
  jq: { name: 'jq', check: 'jq --version', brew: 'jq', winget: 'jqlang.jq' },
}

/** Only known tools, each once: the prompt never carries text from anywhere else. */
export function installable(tools: unknown): string[] {
  return Array.isArray(tools) ? [...new Set(tools.filter((t): t is string => typeof t === 'string' && t in INSTALLABLE))] : []
}

/** What the installer session is asked to do, for this platform. */
export function installPrompt(tools: string[], platform: string): string {
  const list = installable(tools).map((t) => INSTALLABLE[t])
  const names = list.map((t) => t.name).join(', ')
  const checks = list.map((t) => `\`${t.check}\``).join(', ')
  const how =
    platform === 'win32'
      ? `Use winget (\`winget install --id <id> -e\`; ids: ${list.map((t) => `${t.name} → ${t.winget}`).join(', ')}).`
      : platform === 'darwin'
        ? `Use Homebrew (\`brew install ${list.map((t) => t.brew).join(' ')}\`). If \`brew\` itself is missing, install it first with the official installer from https://brew.sh, and tell me any step it prints for me to do (such as adding it to my PATH).`
        : `Use this system's package manager (apt, dnf, pacman...).`
  return [
    `MasterDeck's setup found these tools missing on this computer: ${names}. Please install them.`,
    how,
    `Install nothing else and change no other settings. If a step needs my password or approval, say so and wait.`,
    `When done, check each with ${checks} and tell me the result in one short line per tool. MasterDeck checks them again by itself.`,
  ].join('\n\n')
}
