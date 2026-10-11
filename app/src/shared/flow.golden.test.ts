/**
 * Pins what flows without a loop parse and compile to (#82, Plan L): a flow with no `loop` node
 * must come out byte for byte as it did before loops existed. The fixture was written once from
 * the code before the loop node; a change here is a change to every user's workflow.
 */
import { describe, expect, it } from 'vitest'
import {
  compileFlow,
  defaultFlow,
  docJson,
  flowTriggerCommand,
  HOOK_TRIGGERS,
  parseFlow,
  setCustomTriggers,
  setMonitors,
  type CustomTrigger,
  type MonitorDef,
} from './flow'

const custom: CustomTrigger = {
  id: 'sql-edit',
  name: 'SQL migration edited',
  description: 'A file under migrations changed.',
  event: 'PostToolUse',
  tool: 'Edit|Write',
  field: 'file',
  pattern: 'migrations/.*\\.sql$',
  output: '',
  once: 'commit',
}

const monitor: MonitorDef = {
  id: 'ci-watch',
  name: 'CI',
  description: 'the branch checks',
  timeoutMin: 20,
  rearm: true,
  until: 'the checks pass',
  onEvent: 'fix what failed',
  path: '/h/monitors/ci-watch.sh',
}

/** Every node kind and edge kind of today, plus what the parser drops or rewrites. */
const everyKind = {
  nodes: [
    { id: 't-push', x: 0, y: 0, kind: 'trigger', trigger: 'after-push' },
    { id: 't-start', x: 0, y: 110, kind: 'trigger', trigger: 'session-start' },
    { id: 't-before', x: 0, y: 220, kind: 'trigger', trigger: 'command-before', pattern: 'npm test' },
    { id: 't-after', x: 0, y: 330, kind: 'trigger', trigger: 'command-after', pattern: '(' },
    { id: 't-turn', x: 0, y: 440, kind: 'trigger', trigger: 'turn-end' },
    { id: 't-needs', x: 0, y: 550, kind: 'trigger', trigger: 'needs-you' },
    { id: 't-idle', x: 0, y: 660, kind: 'trigger', trigger: 'idle', minutes: 5000 },
    { id: 't-sql', x: 0, y: 770, kind: 'trigger', trigger: 'custom:sql-edit' },
    { id: 't-gone', x: 0, y: 880, kind: 'trigger', trigger: 'custom:gone' },
    { id: 't-pr', x: 0, y: 990, kind: 'trigger', trigger: 'before-pr' },
    { id: 'tests', x: 290, y: 0, kind: 'skill', skill: 'run-tests', mode: 'session', instructions: 'All of them.' },
    { id: 'dep', x: 290, y: 110, kind: 'skill', skill: 'deploy', mode: 'background', instructions: '' },
    { id: 'noskill', x: 290, y: 220, kind: 'skill', skill: '', mode: 'session', instructions: '' },
    { id: 'ok', x: 580, y: 0, kind: 'instruction', text: 'Post the preview URL.' },
    { id: 'bad', x: 580, y: 110, kind: 'instruction', text: 'Fix it and ask me.' },
    { id: 'after', x: 580, y: 220, kind: 'instruction', text: 'Update the ticket.' },
    { id: 'empty', x: 580, y: 330, kind: 'instruction', text: '  ' },
    { id: 'ping', x: 290, y: 550, kind: 'notify', text: 'It waits on you.' },
    { id: 'pushnote', x: 290, y: 660, kind: 'notify', text: 'Pushed.' },
    { id: 'wake', x: 290, y: 770, kind: 'instruction', text: 'Say where you are.' },
    { id: 'b-pr-review', x: 290, y: 990, kind: 'builtin', builtin: 'pr-review' },
    { id: 'b-pr-review2', x: 290, y: 1100, kind: 'builtin', builtin: 'pr-review' },
    { id: 'b-ticket', x: 290, y: 1210, kind: 'builtin', builtin: 'ticket' },
    { id: 'mon', x: 290, y: 330, kind: 'monitor', monitor: 'ci-watch', args: '<branch>', instructions: '' },
    { id: 'mon-gone', x: 290, y: 440, kind: 'monitor', monitor: 'nope', args: '', instructions: '' },
    { id: 'lonely', x: 900, y: 900, kind: 'instruction', text: 'Never reached.' },
    { id: 'BAD ID', x: 0, y: 0, kind: 'instruction', text: 'dropped' },
    { id: 'what', x: 0, y: 0, kind: 'teleport' },
  ],
  edges: [
    { from: 't-push', to: 'tests' },
    { from: 't-push', to: 'dep' },
    { from: 't-push', to: 'pushnote' },
    { from: 'tests', to: 'ok', kind: 'ok' },
    { from: 'tests', to: 'bad', kind: 'fail' },
    { from: 'tests', to: 'after', kind: 'then' },
    { from: 'bad', to: 'tests', kind: 'then' },
    { from: 't-start', to: 'mon', kind: 'ok' },
    { from: 't-start', to: 'mon-gone' },
    { from: 't-before', to: 'noskill' },
    { from: 't-after', to: 'empty' },
    { from: 't-turn', to: 'after' },
    { from: 't-needs', to: 'ping' },
    { from: 't-needs', to: 'wake' },
    { from: 't-idle', to: 'wake' },
    { from: 't-idle', to: 'b-ticket' },
    { from: 't-sql', to: 'ok' },
    { from: 't-gone', to: 'ok' },
    { from: 't-pr', to: 'b-pr-review' },
    { from: 't-pr', to: 'b-pr-review2' },
    { from: 'b-pr-review', to: 'after' },
    { from: 'ok', to: 't-push' },
    { from: 'ok', to: 'missing' },
    { from: 'ok', to: 'ok' },
    { from: 't-push', to: 'tests' },
  ],
}

const golden = (raw: unknown): object => {
  const flow = parseFlow(raw)
  return {
    parseFlow: flow,
    compileFlow: compileFlow(flow),
    docJson: docJson({ flow, from: null, at: null }),
  }
}

describe('flows without a loop', () => {
  it('parse, compile and hook exactly as before loops', async () => {
    setCustomTriggers([custom])
    setMonitors([monitor])
    const out = {
      defaultFlow: golden(defaultFlow()),
      everyKind: golden(everyKind),
      hooks: Object.fromEntries(
        HOOK_TRIGGERS.map((t) => [t.id, flowTriggerCommand(t, '/h', 'm')]),
      ),
    }
    await expect(JSON.stringify(out, null, 2) + '\n').toMatchFileSnapshot(
      '../../test/fixtures/flow-golden.json',
    )
    setCustomTriggers([])
    setMonitors([])
  })
})
