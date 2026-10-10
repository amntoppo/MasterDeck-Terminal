import { contextBridge, ipcRenderer } from 'electron'
// Constants only (bundled in): a sandboxed preload may require nothing but electron.
import { CAPTURE_CH, type CaptureEnd, type Speaker } from '@shared/meetings'
import type { CaptureBridge } from '@shared/meetingAudio'

/**
 * The meetings capture window's preload (main/meetings/recorder.ts). It can only hand main the
 * recording: chunks, audio slices, levels and its end. Main checks each one (sender, id, track,
 * sequence, size); nothing here can read a file, a setting or another channel.
 */
const capture: CaptureBridge = {
  chunk: (meta: { id: string; track: Speaker; seq: number }, bytes: Uint8Array) => ipcRenderer.send(CAPTURE_CH.chunk, meta, bytes),
  audio: (id: string, bytes: Uint8Array) => ipcRenderer.send(CAPTURE_CH.audio, id, bytes),
  level: (track: Speaker, value: number) => ipcRenderer.send(CAPTURE_CH.level, track, value),
  ended: (reason: CaptureEnd) => ipcRenderer.send(CAPTURE_CH.ended, reason),
}
contextBridge.exposeInMainWorld('capture', capture)
