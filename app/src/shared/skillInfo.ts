/** What each bundled skill does, for the Skills popup. None is needed for MasterDeck itself to work. */
export interface SkillInfo {
  what: string
}

export const SKILL_INFO: Record<string, SkillInfo> = {
  master: { what: 'The master-agent: finds work in issues, PRs and meetings, proposes it, and starts sessions after your yes.' },
  'babysit-ticket': {
    what: 'Optional. Links a session to its issue and moves the board card, run by hand (`/babysit-ticket`). MasterDeck does this automatically.',
  },
  'babysit-pr': {
    what: "Optional. Self-review before a PR and review-comment babysitting, run by hand (`/babysit-pr`). MasterDeck's own PR watch does the babysitting automatically.",
  },
  'babysit-worktree': { what: 'Moves a session into its own git worktree, so its changes stay apart from your checkout.' },
  'kill-worktree': { what: 'Folds a worktree back into the main checkout, keeping every change.' },
  'worktree-janitor': { what: 'Finds finished worktrees across your repos and cleans up the safe ones.' },
  'masterdeck-notes': {
    what: "Lets a session add to your notes: a new note, more text on one it made, or a ticket's note. Sessions never read a note.",
  },
  queue: {
    what: "Optional. `/queue <prompt>` lines up prompts. MasterDeck's hook runs it; the skill only explains when that hook is missing.",
  },
}
