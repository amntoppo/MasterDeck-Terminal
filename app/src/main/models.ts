import { readFileSync } from 'node:fs'

/** The `model` set in Claude Code's settings.json, or null (Claude Code picks its own default). */
export function configuredModel(settingsPath: string): string | null {
  try {
    const m = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { model?: unknown }).model
    return typeof m === 'string' && m.trim() ? m.trim() : null
  } catch {
    return null
  }
}
