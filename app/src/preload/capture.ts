import { contextBridge, ipcRenderer } from 'electron'
// Type-only imports below: they are erased. A sandboxed preload may require nothing but electron,
// and the two preload inputs (index, capture) are one build, so a value imported from a module the
// other preload also uses could land in a shared chunk this one cannot require. capture.test.ts
// checks it, and that these channels are CAPTURE_CH's.
import type { CaptureEnd, Speaker } from '@shared/meetings'
import type { CaptureBridge } from '@shared/meetingAudio'

/** CAPTURE_CH (shared/meetings.ts), written out here for the reason above. */
const CH = { chunk: 'meetings:chunk', audio: 'meetings:audio', level: 'meetings:level', ended: 'meetings:ended' } as const

/**
 * The meetings capture window's preload (main/meetings/recorder.ts). It can only hand main the
 * recording: chunks, audio slices, levels and its end. Main checks each one (sender, id, track,
 * sequence, size); nothing here can read a file, a setting or another channel.
 */
const capture: CaptureBridge = {
  chunk: (meta: { id: string; track: Speaker; seq: number }, bytes: Uint8Array) => ipcRenderer.send(CH.chunk, meta, bytes),
  audio: (id: string, bytes: Uint8Array) => ipcRenderer.send(CH.audio, id, bytes),
  level: (track: Speaker, value: number) => ipcRenderer.send(CH.level, track, value),
  ended: (reason: CaptureEnd) => ipcRenderer.send(CH.ended, reason),
}
contextBridge.exposeInMainWorld('capture', capture)
