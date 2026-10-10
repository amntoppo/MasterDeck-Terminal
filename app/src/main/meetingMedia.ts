import { createReadStream, lstatSync } from 'node:fs'
import { Readable } from 'node:stream'
import { MEETING_ID } from '@shared/meetings'
import { MEDIA_SCHEME } from '@shared/meetingsPage'

/**
 * The window's audio (spec §6, "Audio in the window"): `masterdeck-media://meeting/<id>/audio`
 * answers with that meeting's audio.webm, in byte ranges so the player can seek. Nothing else is
 * reachable through the scheme: the URL must be exactly that shape, the id must match MEETING_ID,
 * and the file must be the one the meetings store names for it (a regular file, not a link). It is
 * registered on the window's session only; the capture window's partition and the web bridge never
 * have it.
 */

const AUDIO_URL = new RegExp(`^${MEDIA_SCHEME}://meeting/(m-[0-9a-f]{32})/audio$`)

/** The meeting id an audio URL names; null for any other URL. */
export function audioId(url: string): string | null {
  const m = AUDIO_URL.exec(url)
  return m && MEETING_ID.test(m[1]!) ? m[1]! : null
}

/** A Range header against a size: the bytes asked for, 'bad' when it cannot be met (416), null for the whole file. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'bad' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  // Several ranges, or another unit: answered with the whole file, as a server may.
  if (!m) return null
  const [, a, b] = m
  if (a === '' && b === '') return 'bad'
  if (a === '') {
    // The last n bytes.
    const n = Number(b)
    if (n === 0 || size === 0) return 'bad'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  if (start >= size || end < start) return 'bad'
  return { start, end }
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })

/**
 * Answer one request of the scheme. `audioFile` (MeetingsIpc.audioFile) gives the store's path for a
 * meeting it holds, else null; it loads the store lazily, so main/meetings/ stays unloaded until a
 * page asks.
 */
export async function serveMeetingAudio(
  req: { url: string; method: string; headers: { get(name: string): string | null } },
  audioFile: (id: string) => Promise<string | null>,
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 })
  const id = audioId(req.url)
  if (!id) return notFound()
  const path = await audioFile(id)
  if (!path) return notFound()
  let size: number
  try {
    const st = lstatSync(path)
    if (!st.isFile()) return notFound()
    size = st.size
  } catch {
    return notFound()
  }
  const base = { 'Content-Type': 'audio/webm', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  const range = parseRange(req.headers.get('range'), size)
  if (range === 'bad') return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
  const { start, end } = range ?? { start: 0, end: size - 1 }
  const length = size === 0 ? 0 : end - start + 1
  const headers = {
    ...base,
    'Content-Length': String(length),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  }
  const body = req.method === 'HEAD' || length === 0 ? null : (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>)
  return new Response(body, { status: range ? 206 : 200, headers })
}
