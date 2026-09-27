import type { HookStatus } from './types'

/** What each bundled skill does, for the Skills popup, and the hook that runs it automatically. */
export interface SkillInfo {
  what: string
  /** The hook that belongs to the skill, and what switching it on does. */
  hook?: { key: keyof HookStatus; label: string; recommended: boolean }
}

export const SKILL_INFO: Record<string, SkillInfo> = {
  master: { what: 'The master-agent: finds work in issues, PRs and meetings, proposes it, and starts sessions after your yes.' },
  'babysit-ticket': {
    what: 'Links a session to its issue and moves the board card as work goes: in progress, PR raised, done.',
    hook: { key: 'ticket', label: 'Move the board automatically as sessions link, open PRs and merge', recommended: true },
  },
  'babysit-pr': {
    what: 'Reviews the branch before a PR is opened, then handles review comments and CI until it merges.',
    hook: { key: 'pr', label: 'Self-review before `gh pr create`, then babysit the PR', recommended: true },
  },
  'babysit-proof': {
    what: 'Runs the end-to-end tests once with a screenshot of every step, and posts them with a summary on the issue.',
    hook: { key: 'proof', label: 'Before each PR, run it in a background subagent (the PR does not wait)', recommended: false },
  },
  'babysit-worktree': { what: 'Moves a session into its own git worktree, so its changes stay apart from your checkout.' },
  'kill-worktree': { what: 'Folds a worktree back into the main checkout, keeping every change.' },
  'worktree-janitor': { what: 'Finds finished worktrees across your repos and cleans up the safe ones.' },
  queue: {
    what: '`/queue <prompt>` lines up prompts that run one by one as each response ends.',
    hook: { key: 'queue', label: 'Make /queue work, and the Queue panel', recommended: true },
  },
}
