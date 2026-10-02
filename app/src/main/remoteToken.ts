import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { tokenProblem } from '@shared/remoteGuard'
import type { CliResult } from '@shared/types'

/** The remote backend's desktop token, encrypted with the macOS Keychain (never in settings.json). */
export function readToken(file: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(readFileSync(file)) || null
  } catch {
    return null
  }
}

export function writeToken(file: string, token: string | null): CliResult {
  try {
    if (token === null) {
      rmSync(file, { force: true })
      return { ok: true, message: 'token removed' }
    }
    const t = token.trim()
    const problem = tokenProblem(t)
    if (problem) return { ok: false, message: problem }
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: 'the Keychain is not available' }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, safeStorage.encryptString(t))
    chmodSync(file, 0o600)
    return { ok: true, message: 'token saved' }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
}
