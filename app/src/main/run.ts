import { spawn } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOpts {
  cwd?: string
  stdin?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export type Runner = (cmd: string, args: string[], opts?: RunOpts) => Promise<RunResult>

/** A Runner over child_process.spawn. Never throws: a missing binary is code -1, a timeout -2. */
export function makeRunner(baseEnv: () => NodeJS.ProcessEnv): Runner {
  return (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (r: RunResult) => {
        if (settled) return
        settled = true
        resolve(r)
      }
      let child
      try {
        // Windows runs .cmd/.bat only through cmd.exe, which does not quote arguments. Quote each
        // one, and refuse characters that stay special inside quotes.
        const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
        if (viaShell && args.some((a) => /["%!\r\n]/.test(a))) {
          finish({ code: -3, stdout: '', stderr: 'argument has characters cmd.exe cannot pass safely' })
          return
        }
        child = spawn(viaShell ? `"${cmd}"` : cmd, viaShell ? args.map((a) => `"${a}"`) : args, {
          cwd: opts.cwd,
          env: { ...baseEnv(), ...(opts.env ?? {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: viaShell,
        })
      } catch (e) {
        finish({ code: -1, stdout: '', stderr: String(e) })
        return
      }
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            child.kill()
            finish({ code: -2, stdout, stderr: stderr + `\ntimed out after ${opts.timeoutMs} ms` })
          }, opts.timeoutMs)
        : null
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', (e) => {
        if (timer) clearTimeout(timer)
        finish({ code: -1, stdout, stderr: String(e) })
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        finish({ code: code ?? -1, stdout, stderr })
      })
      child.stdin.on('error', () => {})
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin)
      child.stdin.end()
    })
}
