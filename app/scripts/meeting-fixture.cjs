// Makes test/fixtures/meetings/audio.webm: a few seconds of tones, one per transcript line of the
// fixture meeting (meeting.json), for the isolated app's Meetings page (OPERATIONS § the meetings
// fixture). With ffmpeg on the PATH it is made by ffmpeg; else by Electron's own MediaRecorder,
// which writes WebM as the real recorder does (no duration, no cues). No microphone is touched:
// the sound is an oscillator. Run from app/: npx electron scripts/meeting-fixture.cjs
const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const OUT = join(__dirname, '..', 'test', 'fixtures', 'meetings', 'audio.webm')
// [start s, length s, Hz]: the fixture's six lines.
const TONES = [
  [0.2, 0.9, 440],
  [1.4, 0.9, 660],
  [2.6, 0.9, 523],
  [3.8, 0.9, 784],
  [5.0, 0.9, 440],
  [6.2, 0.9, 660],
]
const LENGTH = 7.5

function withFfmpeg() {
  const has = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  if (has.status !== 0) return false
  const expr = TONES.map(([s, l, hz]) => `between(t,${s},${s + l})*sin(2*PI*${hz}*t)`).join('+')
  const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `aevalsrc=0.3*(${expr}):s=48000:d=${LENGTH}`, '-c:a', 'libopus', '-b:a', '32k', OUT], { stdio: 'inherit' })
  return r.status === 0
}

if (withFfmpeg()) {
  console.log(`wrote ${OUT} (ffmpeg)`)
  process.exit(0)
}

const { app, BrowserWindow } = require('electron')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  await win.loadURL('about:blank')
  const b64 = await win.webContents.executeJavaScript(`(async () => {
    const tones = ${JSON.stringify(TONES)}
    const ctx = new AudioContext({ sampleRate: 48000 })
    await ctx.resume()
    const dest = ctx.createMediaStreamDestination()
    const t0 = ctx.currentTime + 0.1
    for (const [s, l, hz] of tones) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.value = hz
      g.gain.value = 0.3
      o.connect(g).connect(dest)
      o.start(t0 + s)
      o.stop(t0 + s + l)
    }
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 })
    const parts = []
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data)
    const done = new Promise((r) => (rec.onstop = r))
    rec.start(1000)
    await new Promise((r) => setTimeout(r, ${LENGTH * 1000} + 100))
    rec.stop()
    await done
    const buf = new Uint8Array(await new Blob(parts, { type: 'audio/webm' }).arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(s)
  })()`)
  writeFileSync(OUT, Buffer.from(b64, 'base64'))
  console.log(`wrote ${OUT} (MediaRecorder, ${Buffer.from(b64, 'base64').length} bytes)`)
  app.quit()
})
