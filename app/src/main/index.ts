import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import { CH, type AssignRequest, type QueueEdit } from '@shared/ipc'
import { contextAlerts, diffEvents, newlyNeedsInput } from '@shared/notify'
import { isSafeBgId } from '@shared/paneCommand'
import { isClaudeCommand, tasklistImage } from '@shared/procs'
import { MASTER_NAME } from '@shared/derive'
import type { AppState, CliResult, HookStatus, NotifyEvent, PaneSpec, SetupCheck } from '@shared/types'
import { getConfig } from '@shared/appConfig'
import { startAssign } from './assign'
import { configuredModel } from './models'
import { editQueue, isQueueEdit, readQueue, shiftQueue, unshiftQueue } from './queue'
import { makeGhRunner, readGhCacheStatus } from './ghc'
import { GitHub } from './github'
import { Sender } from './send'
import { Ops } from './ops'
import { cleanEnv, loginPath, resolveClaude } from './env'
import { MasterCli } from './masterCli'
import { resolvePaths } from './paths'
import { PtyManager } from './ptys'
import { makeRunner } from './run'
import { Sources } from './sources'
import { reinstallSkill, syncSkills } from './skills'
import { hookStatus, installHooks } from './hooks'
import { installStatusline, isInstalled, refreshTee, uninstallStatusline } from './statusline'

const SMOKE = process.env.MASTERDECK_SMOKE === '1'
// Dev aid: a separate profile so a test run never shares storage with the installed app.
if (process.env.MASTERDECK_USER_DATA) app.setPath('userData', process.env.MASTERDECK_USER_DATA)

let win: BrowserWindow | null = null
let latest: AppState | null = null
let focused: string | null = null
let pathEnv = process.env.PATH ?? ''
let claudeBin = 'claude'
const contextWarned = new Set<string>()
let contextPrimed = false

const paths = resolvePaths(app.getAppPath(), process.resourcesPath, app.isPackaged)
const env = () => cleanEnv(process.env, pathEnv)
const run = makeRunner(env)
const cli = new MasterCli(run, paths.libDir, paths.python)
const ptys = new PtyManager(env, (channel, ...args) => win?.webContents.send(channel, ...args), () => claudeBin)

function notify(events: NotifyEvent[]): void {
  if (SMOKE || !Notification.isSupported()) return
  for (const e of events.slice(0, 4)) {
    const n = new Notification({ title: e.title, body: e.body, silent: false })
    n.on('click', () => {
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (e.target.sessionKey) win.webContents.send(CH.focusSession, e.target.sessionKey)
      else win.webContents.send(CH.showNeedsYou)
    })
    n.show()
  }
}

const gh = makeGhRunner(run, paths.libDir, paths.python)
const github = new GitHub(run, gh)
const sender = new Sender(ptys, cli, env, () => claudeBin, (key) => latest?.sessions.find((x) => x.key === key))
const ops = new Ops(run, paths, () => claudeBin, gh)
const sources = new Sources(paths, run, cli, (state) => {
  const prev = latest
  latest = state
  win?.webContents.send(CH.state, state)
  notify(diffEvents(prev, state, focused))
  // The first stats scan only records who is already high; warnings are for crossings after that.
  const ctx = contextAlerts(contextWarned, state)
  if (contextPrimed) notify(ctx)
  else if (Object.keys(state.allStats).length) contextPrimed = true
  // Dock badge: the Needs-you count.
  if (state.settings.dockBadge) app.setBadgeCount(state.needsYou.length)
  else if (prev?.settings.dockBadge) app.setBadgeCount(0)
  // Auto-open: a session that just blocked on a prompt gets its tab (not focused) and a dock bounce.
  const blocked = newlyNeedsInput(prev, state)
  if (blocked.length && state.settings.autoOpenNeedsInput) {
    for (const key of blocked) win?.webContents.send(CH.autoOpen, key)
    if (process.platform === 'darwin' && !win?.isFocused()) app.dock?.bounce('informational')
  }
  if (SMOKE && sources.isHealthy('agents') && sources.isHealthy('ledger')) {
    console.log(`SMOKE OK sessions=${state.sessions.length} issues=${state.issues.length} master=${state.master.kind}`)
    app.exit(0)
  }
}, () => claudeBin, github, gh, () => readGhCacheStatus())

function statuslineOpts() {
  return { settingsPath: paths.claudeSettings, home: paths.home, scriptPath: paths.installedTee, python: paths.python }
}

function installHook(): CliResult {
  try {
    mkdirSync(paths.home, { recursive: true })
    copyFileSync(paths.bundledTee, paths.installedTee)
  } catch (e) {
    return { ok: false, message: `could not copy the status line script: ${String(e)}` }
  }
  const r = installStatusline(statuslineOpts())
  sources.statuslineInstalled = isInstalled(paths.claudeSettings, paths.installedTee)
  return r
}

/**
 * Link an existing session to an issue the way the session itself would: babysit-ticket's
 * `tt.sh link`, told which session and folder through TT_SESSION / TT_CWD. Like any
 * babysit-ticket link, it moves the ticket to In Dev (forward only).
 */
async function linkSession(issue: number, sessionId: string, cwd: string | null): Promise<CliResult> {
  if (!Number.isInteger(issue) || issue <= 0) return { ok: false, message: 'bad issue number' }
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return { ok: false, message: 'bad session id' }
  if (!existsSync(paths.babysitTt)) return { ok: false, message: `babysit-ticket not found at ${paths.babysitTt}` }
  const dir = cwd && existsSync(cwd) ? cwd : homedir()
  const r = await run('bash', [paths.babysitTt, 'link', String(issue)], {
    cwd: dir,
    timeoutMs: 60_000,
    env: { TT_SESSION: sessionId, TT_CWD: dir },
  })
  sources.reloadLinks()
  const out = (r.stdout.trim() || r.stderr.trim()).split('\n').filter(Boolean)
  return r.code === 0 ? { ok: true, message: out[0] ?? `linked to #${issue}` } : { ok: false, message: out.at(-1) ?? `exit ${r.code}` }
}

/** Is `pid` a running claude process? Guards the stop against a pid reused by something else. */
async function isClaudePid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false
  if (process.platform === 'win32') {
    const r = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 10_000 })
    const image = tasklistImage(r.stdout)
    return image !== null && isClaudeCommand(image)
  }
  const r = await run('ps', ['-p', String(pid), '-o', 'comm='], { timeoutMs: 10_000 })
  return r.code === 0 && isClaudeCommand(r.stdout)
}

async function stopPid(pid: number): Promise<void> {
  if (process.platform === 'win32') await run('taskkill', ['/PID', String(pid)], { timeoutMs: 10_000 })
  else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  for (let i = 0; i < 20 && (await isClaudePid(pid)); i++) await new Promise((r) => setTimeout(r, 250))
}

/**
 * Start a session that is running in another terminal here: resume its conversation as a
 * background session (then the tab attaches it). With `stopOther`, first stop the other copy,
 * but only when its pid really is a claude process.
 */
/** `claude --bg --resume <id>`: continue a stopped session in the background under the same id. */
async function resumeBg(id: string, name: string, cwd: string | null): Promise<CliResult> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, message: 'bad session id' }
  // A name we can't pass safely is left out: the session keeps the one it has.
  const named = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(name) ? ['-n', name] : []
  const r = await run(claudeBin, ['--bg', '--resume', id, ...named], { cwd: cwd && existsSync(cwd) ? cwd : homedir(), timeoutMs: 60_000 })
  return r.code === 0 ? { ok: true, message: name } : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) }
}

async function startHere(o: { sessionId: string; name: string; cwd: string; pid: number | null; stopOther: boolean }): Promise<CliResult> {
  if (!/^[0-9a-f-]{36}$/i.test(o.sessionId)) return { ok: false, message: 'bad session id' }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(o.name)) return { ok: false, message: `bad session name: ${o.name}` }
  if (o.stopOther && o.pid !== null) {
    if (!(await isClaudePid(o.pid))) return { ok: false, message: `pid ${o.pid} is not a running claude process; nothing was stopped` }
    await stopPid(o.pid)
    if (await isClaudePid(o.pid)) return { ok: false, message: `pid ${o.pid} did not stop; close it in its terminal and try again` }
  }
  const cwd = o.cwd && existsSync(o.cwd) ? o.cwd : homedir()
  const r = await run(claudeBin, ['--bg', '--resume', o.sessionId, '-n', o.name], { cwd, timeoutMs: 60_000 })
  return r.code === 0 ? { ok: true, message: r.stdout.trim().split('\n')[0] ?? 'started' } : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) }
}

async function openEditor(dir: string): Promise<CliResult> {
  for (const bin of process.platform === 'win32' ? ['cursor.cmd', 'code.cmd'] : ['cursor', 'code']) {
    const r = await run(bin, [dir], { timeoutMs: 15_000 })
    if (r.code === 0) return { ok: true, message: `opened in ${bin}` }
  }
  const err = await shell.openPath(dir)
  return err ? { ok: false, message: err } : { ok: true, message: 'opened' }
}

let masterStartingUntil = 0

/**
 * Start master-agent in the background. Refused unless the session list is known to be current and
 * shows no master, and locked for 90 s after a start so a second click cannot start a second master
 * (two sessions named master-agent make the CLI refuse every write).
 */
async function startMaster(): Promise<CliResult> {
  if (!getConfig().masterEnabled) return { ok: false, message: 'master-agent is turned off (Settings → GitHub & board)' }
  if (!sources.isHealthy('agents')) return { ok: false, message: 'the session list is not loaded yet; try again in a few seconds' }
  if (latest && latest.master.kind !== 'absent') return { ok: false, message: `master is already ${latest.master.kind}` }
  if (Date.now() < masterStartingUntil) return { ok: false, message: 'master-agent is already starting' }
  masterStartingUntil = Date.now() + 90_000
  const r = await run(claudeBin, ['--bg', '-n', MASTER_NAME, '/master'], { cwd: paths.masterWorkspace, timeoutMs: 60_000 })
  if (r.code !== 0) masterStartingUntil = 0
  return r.code === 0 ? { ok: true, message: r.stdout.trim() } : { ok: false, message: (r.stderr || r.stdout).trim() }
}

/** Folders live sessions work in (a worktree containing one is IN USE), from the main process's own state. */
function liveDirs(): string[] {
  const s = latest
  if (!s) return []
  const dirs: string[] = []
  for (const x of s.sessions) {
    if (x.state === 'done') continue
    if (x.cwd) dirs.push(x.cwd)
    const cur = s.stats[x.sessionId]?.currentDir ?? s.tails[x.sessionId]?.cwd
    if (cur) dirs.push(cur)
  }
  for (const g of Object.values(s.git)) dirs.push(g.dir)
  return dirs
}

function registerIpc(): void {
  ipcMain.handle(CH.getState, () => latest)
  ipcMain.handle(CH.approve, (_e, id: number) => cli.approve([id]))
  ipcMain.handle(CH.reject, (_e, id: number) => cli.reject([id]))
  ipcMain.handle(CH.draftAssign, (_e, issue: number, title?: string, url?: string) => cli.draftAssign(issue, title, url))
  ipcMain.on(CH.setSprint, (_e, sprint: string) => sources.setSprint(sprint))
  ipcMain.handle(CH.sendText, async (_e, key: string, text: string) => {
    const s = latest?.sessions.find((x) => x.key === key)
    if (!s) return { ok: false, message: 'session not found' }
    const masterUp = latest?.master.kind === 'attached' || latest?.master.kind === 'elsewhere'
    return sender.send(s, text, !!masterUp)
  })
  ipcMain.handle(CH.queueList, (_e, sessionId: string) => readQueue(String(sessionId)))
  ipcMain.handle(CH.queueEdit, (_e, sessionId: string, edit: QueueEdit) =>
    isQueueEdit(edit) ? editQueue(String(sessionId), edit) : { ok: false, message: 'bad queue edit', items: [] },
  )
  ipcMain.handle(CH.queueSendNext, async (_e, key: string) => {
    const s = latest?.sessions.find((x) => x.key === key)
    if (!s) return { ok: false, message: 'session not found' }
    const next = shiftQueue(s.sessionId)
    if (next === null) return { ok: false, message: 'the queue is empty' }
    const masterUp = latest?.master.kind === 'attached' || latest?.master.kind === 'elsewhere'
    const r = await sender.send(s, next, !!masterUp)
    // Not sent: back to the front, so the Stop hook still runs it later.
    if (!r.ok) unshiftQueue(s.sessionId, next)
    return r
  })
  ipcMain.handle(CH.getSettings, () => sources.getSettings())
  ipcMain.handle(CH.setStatus, async (_e, issue: number, status: string) => {
    const r = await ops.setStatus(issue, status)
    if (r.ok) sources.noteStatus(issue, status)
    return r
  })
  ipcMain.handle(CH.standupCommits, (_e, since: number, dirs: string[], until?: number) => ops.standupCommits(since, [...dirs, ...ops.repos()], until))
  ipcMain.handle(CH.janitor, (_e, dirs: string[], force?: boolean) => ops.janitor(dirs, force === true))
  ipcMain.handle(CH.removeWorktree, (_e, repo: string, path: string, force: boolean) => ops.removeWorktree(repo, path, force, liveDirs()))
  ipcMain.handle(CH.removeSession, (_e, bgId: string) => ops.removeSession(bgId))
  ipcMain.handle(CH.searchHistory, (_e, q: string) => ops.searchHistory(q))
  ipcMain.handle(CH.templates, () => ops.templates())
  ipcMain.handle(CH.saveTemplate, (_e, t: { name: string; text: string }) => ops.saveTemplate(t))
  ipcMain.handle(CH.deleteTemplate, (_e, name: string) => ops.deleteTemplate(name))
  ipcMain.handle(CH.resumeSession, (_e, id: string, name: string, cwd: string | null) => resumeBg(id, name, cwd))
  ipcMain.handle(CH.resumeStopped, () => sources.resumeStopped())
  ipcMain.handle(CH.tokensByDay, (_e, ids: unknown) => sources.tokensByDay(Array.isArray(ids) ? ids : []))
  ipcMain.handle(CH.dismissStopped, () => sources.dismissStopped())
  ipcMain.handle(CH.setSettings, (_e, s: unknown) => sources.setSettings(s))
  ipcMain.handle(CH.startHere, (_e, o: Parameters<typeof startHere>[0]) => startHere(o))
  ipcMain.handle(CH.prSummary, (_e, url: string) => github.prSummary(url))
  ipcMain.handle(CH.assignIssue, async (_e, issue: number, login: string, current: string[]) => {
    const r = await github.assign(issue, login, current)
    if (r.ok) sources.noteAssigned(issue, login)
    return r
  })
  ipcMain.handle(CH.assign, (_e, req: AssignRequest) => startAssign(cli, req))
  ipcMain.handle(CH.defaultModel, () => configuredModel(paths.claudeSettings))
  // The Refresh buttons: fetch from GitHub even when the shared gh cache has an answer.
  ipcMain.handle(CH.refresh, () => sources.refreshGithub(true))
  ipcMain.handle(CH.boardRefresh, () => sources.refreshGithub(true))
  ipcMain.handle(CH.setupCheck, () => setupCheck())
  ipcMain.handle(CH.configDetect, (_e, owner: unknown, project: unknown) =>
    typeof owner === 'string' ? cli.configDetect(owner.trim(), typeof project === 'number' ? project : undefined) : { ok: false, message: 'owner required' },
  )
  ipcMain.handle(CH.configSave, async (_e, patch: unknown) => {
    const r = await cli.configSave(patch)
    if (r.ok) sources.loadConfig()
    return r
  })
  ipcMain.handle(CH.pickFolder, async (_e, start: unknown) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath: typeof start === 'string' && start ? start : homedir() })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(CH.hooksInstall, (_e, which: HookStatus) => {
    const r = installHooks(paths.claudeSettings, paths.home, { ticket: !!which?.ticket, pr: !!which?.pr, queue: !!which?.queue })
    sources.setHooks(hookStatus(paths.claudeSettings))
    return r
  })
  ipcMain.handle(CH.skillReinstall, (_e, name: unknown) => {
    if (typeof name !== 'string') return { ok: false, message: 'bad skill name' }
    const r = reinstallSkill(paths.bundledSkills, paths.skillsDir, name, app.getVersion())
    sources.setSkills(syncSkills(paths.bundledSkills, paths.skillsDir, app.getVersion()).skills)
    return r
  })
  ipcMain.handle(CH.teamPrsRefresh, (_e, maxAgeMs: unknown) => typeof maxAgeMs === 'number' && maxAgeMs > 0 ? sources.refreshTeamPrs(maxAgeMs) : sources.refreshTeamPrs(0, true))
  ipcMain.handle(CH.linkSession, (_e, issue: number, sessionId: string, cwd: string | null) => linkSession(issue, sessionId, cwd))
  ipcMain.on(CH.boardOpen, (_e, open: boolean) => sources.setBoardOpen(open))
  ipcMain.on(CH.setFocus, (_e, id: string | null) => {
    focused = id
    sources.setFocus(id)
  })
  ipcMain.on(CH.setVisible, (_e, ids: string[]) => sources.setVisible(ids))
  ipcMain.on(CH.openExternal, (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle(CH.openEditor, (_e, dir: string) => openEditor(dir))
  ipcMain.on(CH.copy, (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle(CH.stopSession, async (_e, bgId: string, name: string) => {
    if (!isSafeBgId(bgId)) return { ok: false, message: 'bad background id' }
    const choice = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: ['Cancel', 'Stop session'],
      defaultId: 0,
      cancelId: 0,
      message: `Stop ${name}?`,
      detail: 'The background session ends. Its conversation is kept and can be resumed later.',
    })
    if (choice.response !== 1) return { ok: false, message: 'cancelled' }
    const r = await run(claudeBin, ['stop', bgId], { timeoutMs: 30_000 })
    return r.code === 0 ? { ok: true, message: 'stopped' } : { ok: false, message: (r.stderr || r.stdout).trim() }
  })
  ipcMain.handle(CH.statuslineInstall, () => installHook())
  ipcMain.handle(CH.statuslineUninstall, () => {
    const r = uninstallStatusline(statuslineOpts())
    sources.statuslineInstalled = isInstalled(paths.claudeSettings, paths.installedTee)
    return r
  })
  ipcMain.handle(CH.masterStart, () => startMaster())
  ipcMain.handle(CH.ptyOpen, (_e, id: string, spec: PaneSpec, cols: number, rows: number) => ptys.open(id, spec, cols, rows))
  ipcMain.on(CH.ptyWrite, (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on(CH.ptyResize, (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ipcMain.on(CH.ptyClose, (_e, id: string) => ptys.close(id))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1560,
    height: 940,
    minWidth: 1000,
    minHeight: 600,
    show: false,
    title: 'MasterDeck',
    backgroundColor: '#0f1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.on('ready-to-show', () => {
    if (!SMOKE) win?.show()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => {
    win = null
  })
}

/** What Setup needs to know: which tools are on PATH and who gh is logged in as. */
async function setupCheck(): Promise<SetupCheck> {
  const ok = async (cmd: string, args: string[]) => (await run(cmd, args, { timeoutMs: 15_000 })).code === 0
  const [ghOk, py, jq, git, user, status] = await Promise.all([
    ok('gh', ['--version']),
    ok(paths.python, ['--version']),
    ok('jq', ['--version']),
    ok('git', ['--version']),
    run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 20_000 }),
    run('gh', ['auth', 'status'], { timeoutMs: 20_000 }),
  ])
  const login = user.code === 0 ? user.stdout.trim() : ''
  const scopes = /Token scopes:\s*(.+)/.exec(status.stdout + status.stderr)?.[1] ?? ''
  const claudeOk = await ok(claudeBin, ['--version'])
  return {
    claude: claudeOk ? claudeBin : null,
    gh: ghOk,
    ghUser: /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : null,
    ghScopes: scopes.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
    python: py,
    jq,
    git,
  }
}

app.whenReady().then(async () => {
  app.setName('MasterDeck')
  pathEnv = await loginPath()
  claudeBin = await resolveClaude(env())
  registerIpc()
  sources.setLinker(linkSession)
  sources.statuslineInstalled = isInstalled(paths.claudeSettings, paths.installedTee)
  if (sources.statuslineInstalled) {
    // settings.json points at the installed copy: keep it present and current with this app version.
    const r = refreshTee(paths.bundledTee, paths.installedTee)
    if (r) console.error(r)
  } else if (!SMOKE && process.env.MASTERDECK_NO_HOOK !== '1') {
    const r = installHook()
    if (!r.ok) console.error(r.message)
  }
  // Bundled skills: install the missing ones, update our own unmodified copies.
  if (process.env.MASTERDECK_NO_SKILLS !== '1') {
    const r = syncSkills(paths.bundledSkills, paths.skillsDir, app.getVersion())
    for (const e of r.errors) console.error(e)
    sources.setSkills(r.skills)
  }
  sources.setHooks(hookStatus(paths.claudeSettings))
  createWindow()
  sources.setResumer((e) => resumeBg(e.sessionId, e.name, e.cwd))
  sources.start()
  if (SMOKE) {
    setTimeout(() => {
      console.log('SMOKE FAIL: no healthy state within 30 s', JSON.stringify(latest?.errors ?? []))
      app.exit(1)
    }, 30_000)
  }
  // Dev aid: MASTERDECK_CAPTURE=<png> saves a screenshot of the window (after running
  // MASTERDECK_CAPTURE_JS in the page, if set) and quits.
  const capture = process.env.MASTERDECK_CAPTURE
  if (capture) {
    // Test runs only: the capture script can ask for named screenshots along the way.
    ipcMain.handle('test:shot', async (_e, name: string) => {
      const img = await win?.webContents.capturePage()
      const file = join(dirname(capture), `${String(name).replace(/[^\w.-]/g, '_')}.png`)
      if (img) writeFileSync(file, img.toPNG())
      return file
    })
    setTimeout(async () => {
      const js = process.env.MASTERDECK_CAPTURE_JS
      if (js) console.log('capture js:', await win?.webContents.executeJavaScript(js).catch((e) => `error ${e}`))
      setTimeout(async () => {
        const img = await win?.webContents.capturePage()
        if (img) writeFileSync(capture, img.toPNG())
        console.log(`captured ${capture}`)
        app.exit(0)
      }, Number(process.env.MASTERDECK_CAPTURE_WAIT ?? 4000))
    }, 8000)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())

// Cmd+Q skips window-all-closed; clean up here so no `claude attach` outlives the app.
app.on('will-quit', () => {
  sender.killAll()
  ptys.closeAll()
  sources.stop()
})

