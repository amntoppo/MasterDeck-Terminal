import { shell, systemPreferences } from 'electron'
import {
  meetingsAgreed,
  privacyPane,
  soundStatus,
  systemAudioPath,
  type MediaStatus,
  type MeetingsAnswer,
  type MeetingsGrant,
  type MeetingsSettings,
  type MeetingsSetupInfo,
  type SystemAudioCheck,
  type SystemAudioPath,
} from '@shared/meetings'

/**
 * The one owner of macOS's media permissions (spec §1). Loaded with `await import()` only, the
 * first time Settings → Meetings asks for its state; nothing at startup touches it. Before consent
 * it only reads grants (getMediaAccessStatus, which never prompts); askForMediaAccess and the
 * sound check run only after consent and a press of Allow.
 */
export interface GateDeps {
  /** Settings → Meetings as stored now. */
  meetings(): MeetingsSettings
  /** Store the sound check's result (settings, atomic). */
  saveSystemAudio(check: SystemAudioCheck): void
  /** process.getSystemVersion(), e.g. "14.2.1". */
  macosVersion: string
  now?: () => number
}

const STATUSES: ReadonlySet<string> = new Set(['not-determined', 'granted', 'denied', 'restricted', 'unknown'])
const status = (s: string): MediaStatus => (STATUSES.has(s) ? (s as MediaStatus) : 'unknown')

export class MeetingsGate {
  /**
   * A 1-second capture in the capture window (the recorder fills this in): true when the Mac's
   * sound came through, a live audio track that is not silent. Until then Allow opens System
   * Settings and the status stays "Not checked yet".
   */
  probeSystemAudio: (() => Promise<boolean>) | null = null
  readonly path: SystemAudioPath
  /** Allow for Accessibility was pressed in this run: still not trusted then reads as denied. */
  private askedAccess = false

  constructor(private deps: GateDeps) {
    this.path = systemAudioPath(deps.macosVersion)
  }

  /** The screen's state. Reads only: never asks macOS anything. */
  setup(message?: string): MeetingsSetupInfo {
    const m = this.deps.meetings()
    // The Screen Recording grant is the sound's only on macOS 13 to 14.1 (OPERATIONS § Meetings: capture).
    const screenGrant: MediaStatus = this.path === 'screen' ? status(systemPreferences.getMediaAccessStatus('screen')) : 'unknown'
    return {
      ok: true,
      mac: true,
      agreed: meetingsAgreed({ meetings: m }),
      mic: status(systemPreferences.getMediaAccessStatus('microphone')),
      screen: soundStatus(this.path, screenGrant, m.systemAudio),
      accessibility: this.accessibilityTrusted() ? 'granted' : this.askedAccess ? 'denied' : 'not-determined',
      systemAudio: this.path,
      model: { name: m.model, ready: false },
      settings: m,
      ...(message ? { message } : {}),
    }
  }

  /**
   * Whether macOS lets MasterDeck (and md-mute, which it starts) read other apps' controls. The
   * non-prompting read: it asks nothing (the mute watch calls it before each start of md-mute).
   */
  accessibilityTrusted(): boolean {
    return systemPreferences.isTrustedAccessibilityClient(false)
  }

  /** Allow (or, once refused, Open System Settings) for the microphone, the Mac's sound or Accessibility. Refused without consent. */
  async permission(kind: MeetingsGrant): Promise<MeetingsAnswer> {
    if (!meetingsAgreed({ meetings: this.deps.meetings() })) return { ok: false, message: 'Agree to how meetings work first.' }
    if (kind === 'accessibility') {
      if (this.accessibilityTrusted()) return this.setup()
      // macOS has no "refused" for Accessibility: the first press brings up its prompt (which
      // points to System Settings); a press after that, still not trusted, opens the pane.
      if (this.askedAccess) return this.openPane('accessibility')
      this.askedAccess = true
      systemPreferences.isTrustedAccessibilityClient(true)
      return this.setup()
    }
    if (kind === 'mic') {
      const now = status(systemPreferences.getMediaAccessStatus('microphone'))
      // macOS asks once: after a refusal only System Settings can change it.
      if (now === 'denied' || now === 'restricted') return this.openPane('mic')
      if (now !== 'granted') await systemPreferences.askForMediaAccess('microphone')
      return this.setup()
    }
    if (this.path === 'none') return this.setup('This macOS cannot record the sound the Mac plays: meetings record your microphone only.')
    if (this.path === 'screen') {
      const now = status(systemPreferences.getMediaAccessStatus('screen'))
      if (now === 'granted') return this.setup()
      if (now === 'denied' || now === 'restricted') return this.openPane('screen')
    }
    const probe = this.probeSystemAudio
    if (!probe) return this.openPane('screen')
    const ok = await probe().catch(() => false)
    this.deps.saveSystemAudio({ at: (this.deps.now ?? Date.now)(), ok })
    return this.setup(ok ? undefined : 'No sound came through. Allow MasterDeck in System Settings, then restart MasterDeck and try again.')
  }

  private async openPane(kind: MeetingsGrant): Promise<MeetingsSetupInfo> {
    await shell.openExternal(privacyPane(kind, this.path))
    return this.setup('System Settings is open: allow MasterDeck there, then come back.')
  }
}
