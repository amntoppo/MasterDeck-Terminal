import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Loopback {
  port: number
  result: Promise<{ code: string; state: string } | null>
  close(): void
}

/** One-shot 127.0.0.1 listener for the browser's `/callback?code&state` redirect. Rejects if it can't listen. */
export function startLoopback(opts: { timeoutMs?: number; host?: string; state?: string } = {}): Promise<Loopback> {
  return new Promise((resolveStart, rejectStart) => {
    let settle!: (v: { code: string; state: string } | null) => void
    const result = new Promise<{ code: string; state: string } | null>((r) => (settle = r))
    let done = false
    const server = createServer((req, res) => {
      if (!URL.canParse(req.url ?? '/', 'http://127.0.0.1')) return void res.writeHead(400).end()
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const code = u.searchParams.get('code')
      const state = u.searchParams.get('state')
      if (req.method !== 'GET' || u.pathname !== '/callback') return void res.writeHead(404).end()
      if (done) return void res.writeHead(410).end()
      if (!code || !state || code.length > 256 || state.length > 256) return void res.writeHead(400).end()
      if (opts.state !== undefined && !sameState(state, opts.state)) return void res.writeHead(400).end()
      done = true
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<!doctype html><title>MasterDeck</title><p>Signed in. You can go back to MasterDeck.</p>')
      res.on('close', finish)
      settle({ code, state })
    })
    const timer = setTimeout(() => finish(), opts.timeoutMs ?? 300_000)
    function finish(): void {
      done = true
      clearTimeout(timer)
      settle(null)
      server.close()
      server.closeAllConnections()
    }
    server.once('error', rejectStart)
    server.listen(0, opts.host ?? '127.0.0.1', () => {
      server.off('error', rejectStart)
      resolveStart({ port: (server.address() as AddressInfo).port, result, close: finish })
    })
  })
}

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
