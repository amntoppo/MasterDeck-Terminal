import { describe, expect, it } from 'vitest'
import { Ops } from './ops'
import type { Paths } from './paths'
import type { Runner } from './run'

describe('standupCommits', () => {
  it("counts commits by the repo's own email and by every connected account's", async () => {
    const logs: string[][] = []
    const run: Runner = async (_cmd, args) => {
      if (args.includes('--git-common-dir')) return { code: 0, stdout: '/r/app/.git\n', stderr: '' }
      if (args.includes('user.email')) return { code: 0, stdout: 'me@acme.test\n', stderr: '' }
      logs.push(args)
      return { code: 0, stdout: '', stderr: '' }
    }
    const ops = new Ops(run, { masterWorkspace: '/r' } as Paths, () => 'claude', undefined, () => ['b@globex.test', 'me@acme.test'])
    await ops.standupCommits(0, [process.cwd()])
    expect(logs[0].filter((a) => a.startsWith('--author='))).toEqual(['--author=me@acme.test', '--author=b@globex.test'])
    const one = new Ops(run, { masterWorkspace: '/r' } as Paths, () => 'claude')
    await one.standupCommits(0, [process.cwd()])
    expect(logs[1].filter((a) => a.startsWith('--author='))).toEqual(['--author=me@acme.test'])
  })
})
