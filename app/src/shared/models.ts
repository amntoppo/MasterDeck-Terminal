/**
 * Models a new session can start on: Claude Code's `--model` aliases, which always mean the
 * latest model of each family. The empty value starts without `--model` (Claude Code's default).
 */
export const MODELS: { value: string; label: string }[] = [
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'opus[1m]', label: 'Opus (1M context)' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'sonnet[1m]', label: 'Sonnet (1M context)' },
  { value: 'haiku', label: 'Haiku' },
]

/** The "Default" option's label: names the model set in ~/.claude/settings.json, when there is one. */
export function defaultModelLabel(configured: string | null): string {
  if (!configured) return 'Default'
  return `Default · ${MODELS.find((m) => m.value === configured)?.label ?? configured}`
}
