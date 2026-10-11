import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { tokenProblem } from '@shared/remoteGuard'
import type { CliResult } from '@shared/types'
import type { SafeStore } from './macKey'

/** The remote backend's desktop token, encrypted with the macOS Keychain (never in settings.json). */
export function readToken(file: string, safe: SafeStore = safeStorage): string | null {
  try {
    // No token file, no Keychain: asking it can put a dialog on screen that blocks the main thread.
    if (!existsSync(file)) return null
    if (!safe.isEncryptionAvailable()) return null
    return safe.decryptString(readFileSync(file)) || null
  } catch {
    return null
  }
}

export function writeToken(file: string, token: string | null, safe: SafeStore = safeStorage): CliResult {
  try {
    if (token === null) {
      rmSync(file, { force: true })
      return { ok: true, message: 'token removed' }
    }
    const t = token.trim()
    const problem = tokenProblem(t)
    if (problem) return { ok: false, message: problem }
    if (!safe.isEncryptionAvailable()) return { ok: false, message: 'the Keychain is not available' }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, safe.encryptString(t))
    chmodSync(file, 0o600)
    return { ok: true, message: 'token saved' }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
}
