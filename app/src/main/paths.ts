import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface Paths {
  /** Folder that contains the `master` Python package. */
  libDir: string
  /** The tee script shipped with the app (copied into `home` on install). */
  bundledTee: string
  /** Stable copy of the tee script that settings.json points at. */
  installedTee: string
  home: string
  statsDir: string
  claudeSettings: string
  projectsDir: string
  ledger: string
  masterWorkspace: string
  python: string
  /** babysit-ticket's CLI and its session↔issue links. */
  babysitTt: string
  babysitState: string
  /** Skills shipped with the app (copied into skillsDir on first launch). */
  bundledSkills: string
  /** Where Claude Code looks for the user's skills. */
  skillsDir: string
  /** The shared config (GitHub owner, board, statuses, workspace). */
  config: string
}

/**
 * `appRoot` is `app.getAppPath()`; `resourcesPath` is `process.resourcesPath`. In development the
 * app runs from `<repo>/app`, so the skills are in `<repo>/skills`. Packaged, they ship in
 * `resources/skills`. The installed master skill (`~/.claude/skills/master`) wins when it exists,
 * so the app always uses the CLI the master skill uses.
 */
export function resolvePaths(appRoot: string, resourcesPath: string, packaged: boolean): Paths {
  const h = homedir()
  const skillsDir = process.env.MASTERDECK_SKILLS_DIR || join(h, '.claude', 'skills')
  const skillLib = join(skillsDir, 'master', 'lib')
  const bundledSkills = packaged ? join(resourcesPath, 'skills') : resolve(appRoot, '..', 'skills')
  const libDir = existsSync(join(skillLib, 'master')) ? skillLib : join(bundledSkills, 'master', 'lib')
  const home = process.env.MASTERDECK_HOME || join(h, '.claude', 'masterdeck')
  const masterHome = process.env.MASTER_HOME || join(h, '.claude', 'master')
  return {
    libDir,
    bundledTee: packaged ? join(resourcesPath, 'statusline_tee.py') : join(appRoot, 'resources', 'statusline_tee.py'),
    installedTee: join(home, 'statusline_tee.py'),
    home,
    statsDir: join(home, 'stats'),
    claudeSettings: process.env.MASTERDECK_CLAUDE_SETTINGS || join(h, '.claude', 'settings.json'),
    projectsDir: join(h, '.claude', 'projects'),
    ledger: join(masterHome, 'ledger.json'),
    // Replaced by the config's workspace once it loads (see Sources.applyConfig).
    masterWorkspace: process.env.MASTER_WORKSPACE || join(h, 'Documents'),
    python: process.platform === 'win32' ? 'python' : 'python3',
    babysitTt: join(h, '.claude', 'skills', 'babysit-ticket', 'scripts', 'tt.sh'),
    babysitState: join(process.env.TT_STATE_DIR || join(h, '.claude', 'babysit-ticket'), 'state.json'),
    bundledSkills,
    skillsDir,
    config: process.env.MASTER_CONFIG || join(masterHome, 'config.json'),
  }
}
