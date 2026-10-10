import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { storedMeeting } from '@shared/meetings'
import { storedNote } from '@shared/notes'

/**
 * Test aid for the isolated app (OPERATIONS § the meetings fixture): MASTERDECK_MEETINGS_FIXTURE=<dir>
 * with MASTERDECK_ISOLATED=1 and MASTERDECK_HOME set (never the real ~/.claude/masterdeck) copies `<dir>/meeting.json`, `<dir>/audio.webm` and any
 * `<dir>/notes/*.json` into MASTERDECK_HOME at start. Each file is checked as the store would read
 * it, and nothing already there is overwritten. Asks macOS nothing and loads no meetings code.
 */
export function copyMeetingsFixture(env: NodeJS.ProcessEnv, home: string): string | null {
  const dir = env.MASTERDECK_MEETINGS_FIXTURE
  if (!dir || env.MASTERDECK_ISOLATED !== '1' || !env.MASTERDECK_HOME) return null
  const raw = JSON.parse(readFileSync(join(dir, 'meeting.json'), 'utf8')) as { id?: unknown }
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!storedMeeting(raw, id)) throw new Error('meeting.json is not a meeting')
  const meetings = join(home, 'meetings')
  mkdirSync(join(meetings, id), { recursive: true })
  const file = join(meetings, `${id}.json`)
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(raw, null, 2))
  const audio = join(dir, 'audio.webm')
  const to = join(meetings, id, 'audio.webm')
  if (existsSync(audio) && lstatSync(audio).isFile() && !existsSync(to)) copyFileSync(audio, to)
  const notesIn = join(dir, 'notes')
  if (existsSync(notesIn)) {
    const notes = join(home, 'notes')
    mkdirSync(notes, { recursive: true })
    for (const f of readdirSync(notesIn)) {
      const nid = f.replace(/\.json$/, '')
      if (nid === f) continue
      const note = JSON.parse(readFileSync(join(notesIn, f), 'utf8'))
      if (!storedNote(note, nid)) throw new Error(`notes/${f} is not a note`)
      if (!existsSync(join(notes, f))) writeFileSync(join(notes, f), JSON.stringify(note, null, 2))
    }
  }
  return id
}
