// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (e: unknown, ...a: any[]) => unknown;

/** Stand-in for the IPC event: handlers on the allowlist must not use it (checked in browserBridge tests). */
const REMOTE_EVENT = Object.freeze({ remote: true });

/** Registers IPC handlers and keeps them callable by channel, so the browser bridge runs exactly what IPC runs. */
export class IpcRegistry {
  private fns = new Map<string, Fn>();
  constructor(
    private ipc: { handle(ch: string, fn: Fn): void; on(ch: string, fn: Fn): void },
  ) {}
  handle(ch: string, fn: Fn): void {
    this.fns.set(ch, fn);
    this.ipc.handle(ch, fn);
  }
  on(ch: string, fn: Fn): void {
    this.fns.set(ch, fn);
    this.ipc.on(ch, fn);
  }
  async call(ch: string, args: unknown[]): Promise<unknown> {
    const fn = this.fns.get(ch);
    if (!fn) throw new Error(`no handler for ${ch}`);
    return fn(REMOTE_EVENT, ...args);
  }
}
