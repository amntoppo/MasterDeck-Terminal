import { describe, expect, it } from 'vitest'
import { compileFlow, edgeId, layoutFlow, newLoop, parseFlow, type EdgeKind, type Flow, type FlowNode } from './flow'
import {
  edgeKindFrom,
  frameArrow,
  frameEdges,
  frameHeader,
  frameLive,
  framedEdgeKinds,
  insideFrame,
  membersAfterDrop,
  moveFrame,
  refitFrame,
  type LoopNode,
} from './flowFrame'
import type { LoopView } from './loops'

const e = (from: string, to: string, kind: EdgeKind = 'then') => ({ id: edgeId(from, to), from, to, kind })
const T = (id: string) => ({ id, x: 0, y: 0, kind: 'trigger', trigger: 'pr-created' }) as FlowNode
const I = (id: string, x = 0, y = 0) => ({ id, x, y, kind: 'instruction', text: id }) as FlowNode
const L = (id: string, members: string[], extra: Partial<LoopNode> = {}) =>
  ({ ...newLoop(id, 0, 0), members, check: { command: 'npm test', output: '', outputMode: 'match', timeoutMin: 5 }, ...extra }) as LoopNode
const node = (f: Flow, id: string) => f.nodes.find((n) => n.id === id)!
const loop = (f: Flow, id: string) => node(f, id) as LoopNode

describe('layoutFlow without loops', () => {
  it('places blocks exactly as before loops', () => {
    const flow: Flow = {
      nodes: [T('t1'), I('a'), I('b'), I('c'), I('d'), T('t2'), I('e'), I('lost')],
      edges: [e('t1', 'a'), e('a', 'b', 'ok'), e('a', 'c', 'fail'), e('c', 'd'), e('b', 'd'), e('t2', 'e')],
    }
    expect(layoutFlow(flow).nodes.map((n) => [n.id, n.x, n.y])).toMatchInlineSnapshot(`
      [
        [
          "t1",
          0,
          0,
        ],
        [
          "a",
          290,
          0,
        ],
        [
          "b",
          580,
          0,
        ],
        [
          "c",
          580,
          110,
        ],
        [
          "d",
          870,
          0,
        ],
        [
          "t2",
          0,
          220,
        ],
        [
          "e",
          290,
          220,
        ],
        [
          "lost",
          290,
          330,
        ],
      ]
    `)
  })
})

describe('layoutFlow with a loop', () => {
  // A draft from Build with Claude: no positions.
  const draft: Flow = {
    nodes: [T('t'), L('lp', ['run', 'fix', 'side']), I('run'), I('fix'), I('side'), I('after'), I('next')],
    edges: [e('t', 'lp'), e('run', 'fix'), e('lp', 'after', 'met'), e('t', 'next')],
  }
  const laid = layoutFlow(draft)

  it('puts every member inside its frame, and the frame around them', () => {
    const f = loop(laid, 'lp')
    for (const m of f.members) expect(insideFrame(node(laid, m), f)).toBe(true)
    // run → fix side by side, side on a row of its own.
    expect(node(laid, 'fix').x).toBeGreaterThan(node(laid, 'run').x)
    expect(node(laid, 'fix').y).toBe(node(laid, 'run').y)
    expect(node(laid, 'side').y).toBeGreaterThan(node(laid, 'run').y)
    expect(f.x + f.w).toBeGreaterThanOrEqual(node(laid, 'fix').x + 190)
    expect(f.y + f.h).toBeGreaterThanOrEqual(node(laid, 'side').y + 70)
  })

  it('places what follows right of the frame and new rows below it', () => {
    const f = loop(laid, 'lp')
    expect(node(laid, 'after').x).toBeGreaterThan(f.x + f.w)
    expect(node(laid, 'after').y).toBe(f.y)
    expect(node(laid, 'next').y).toBeGreaterThan(f.y + f.h)
    expect(insideFrame(node(laid, 'after'), f)).toBe(false)
    expect(insideFrame(node(laid, 'next'), f)).toBe(false)
  })

  it('keeps an empty frame its size', () => {
    const out = layoutFlow({ nodes: [T('t'), L('lp', [], { w: 500, h: 260 })], edges: [e('t', 'lp')] })
    expect([loop(out, 'lp').w, loop(out, 'lp').h]).toEqual([500, 260])
  })

  it('survives parseFlow and compiles with the members in the loop', () => {
    const f = parseFlow(laid)
    expect(loop(f, 'lp').members).toEqual(['run', 'fix', 'side'])
    expect(compileFlow(f).problems.filter((p) => p.node === 'lp')).toEqual([])
  })
})

describe('the frame on the canvas', () => {
  const base = (): Flow => ({
    nodes: [
      T('t'),
      { ...L('lp', ['a']), x: 300, y: 0, w: 500, h: 250 },
      I('a', 330, 50),
      I('b', 900, 50),
      I('c', 900, 300),
    ],
    edges: [e('t', 'lp'), e('lp', 'c', 'met')],
  })

  it('tells a block in the frame by its centre', () => {
    const f = loop(base(), 'lp')
    expect(insideFrame(I('x', 330, 50), f)).toBe(true)
    expect(insideFrame(I('x', 700, 50), f)).toBe(true) // centre at 795
    expect(insideFrame(I('x', 720, 50), f)).toBe(false) // centre at 815
    expect(insideFrame(I('x', 330, 230), f)).toBe(false)
  })

  it('a block dropped in joins the frame; dragged out, it leaves', () => {
    const moved = { ...base(), nodes: base().nodes.map((n) => (n.id === 'b' ? { ...n, x: 560, y: 60 } : n)) }
    const into = membersAfterDrop(moved, 'b')
    expect(into.note).toBeNull()
    expect(loop(into.flow, 'lp').members).toEqual(['a', 'b'])
    const away = { ...into.flow, nodes: into.flow.nodes.map((n) => (n.id === 'a' ? { ...n, x: 300, y: 500 } : n)) }
    expect(loop(membersAfterDrop(away, 'a').flow, 'lp').members).toEqual(['b'])
    // Dropped where it was: nothing changes.
    expect(membersAfterDrop(base(), 'a').flow).toEqual(base())
  })

  it('never takes a trigger, a built-in or a loop: it goes back outside', () => {
    for (const n of [
      { ...T('t2'), x: 400, y: 60 },
      { id: 'bi', x: 400, y: 60, kind: 'builtin', builtin: 'pr-watch' } as FlowNode,
      { ...L('lp2', []), x: 350, y: 20, w: 200, h: 150 },
    ]) {
      const flow = { ...base(), nodes: [...base().nodes, n] }
      const out = membersAfterDrop(flow, n.id)
      expect(out.note).toBeTruthy()
      expect(loop(out.flow, 'lp').members).toEqual(['a'])
      expect(insideFrame(node(out.flow, n.id), loop(out.flow, 'lp'))).toBe(false)
    }
  })

  it('arrows follow a block in and out of a frame', () => {
    // b → a while both are outside, then a joins: b's arrow enters the frame; a's arrow out goes.
    const flow: Flow = {
      nodes: [{ ...L('lp', []), x: 300, y: 0, w: 500, h: 250 }, I('a', 330, 50), I('b', 0, 400), I('c', 900, 400)],
      edges: [e('b', 'a', 'ok'), e('a', 'c')],
    }
    const out = membersAfterDrop(flow, 'a').flow
    expect(out.edges).toEqual([e('b', 'lp', 'ok')])
  })

  it('an arrow that would close a cycle once the block is in is dropped', () => {
    const flow: Flow = {
      nodes: [{ ...L('lp', []), x: 300, y: 0, w: 500, h: 250 }, I('a', 330, 50), I('b', 0, 400)],
      edges: [e('lp', 'b', 'met'), e('b', 'a')],
    }
    expect(membersAfterDrop(flow, 'a').flow.edges).toEqual([e('lp', 'b', 'met')])
  })

  it('a frame put down over a block takes it in, and says so when an arrow had to go', () => {
    const flow: Flow = {
      nodes: [{ ...L('lp', []), x: 300, y: 0, w: 500, h: 250 }, I('a', 330, 50), I('b', 0, 400)],
      edges: [e('a', 'b')],
    }
    const out = membersAfterDrop(flow, 'lp')
    expect(loop(out.flow, 'lp').members).toEqual(['a'])
    expect(out.flow.edges).toEqual([])
    expect(out.note).toMatch(/arrows were removed/)
    expect(membersAfterDrop({ ...flow, edges: [] }, 'lp').note).toBeNull()
  })

  it('moves a frame with its members, and nothing else', () => {
    const out = moveFrame(base(), 'lp', 10, -5)
    expect([node(out, 'lp').x, node(out, 'lp').y]).toEqual([310, -5])
    expect([node(out, 'a').x, node(out, 'a').y]).toEqual([340, 45])
    expect(node(out, 'b')).toEqual(node(base(), 'b'))
    expect(moveFrame(base(), 'a', 10, 10)).toEqual(base())
  })

  it('a resized frame takes the blocks now inside it and lets go of the others', () => {
    const wider = { ...base(), nodes: base().nodes.map((n) => (n.id === 'lp' ? { ...n, w: 900 } : n)) }
    expect(loop(refitFrame(wider, 'lp'), 'lp').members).toEqual(['a', 'b'])
    const small = { ...base(), nodes: base().nodes.map((n) => (n.id === 'lp' ? { ...n, w: 100, h: 40 } : n)) }
    expect(loop(refitFrame(small, 'lp'), 'lp').members).toEqual([])
    expect(refitFrame(base(), 'lp')).toEqual(base())
  })

  it('an arrow into a member enters the frame; one out of a member is refused', () => {
    expect(frameArrow(base(), 'b', 'a')).toEqual({ from: 'b', to: 'lp' })
    expect(frameArrow(base(), 'a', 'b')).toHaveProperty('refuse')
    expect(frameArrow(base(), 'lp', 'a')).toHaveProperty('refuse')
    expect(frameArrow(base(), 'b', 'c')).toEqual({ from: 'b', to: 'c' })
  })

  it('a frame leaves through met / limit, a block through ok / fail', () => {
    expect(framedEdgeKinds('loop')).toEqual(['then', 'met', 'limit'])
    expect(framedEdgeKinds('skill')).toEqual(['then', 'ok', 'fail'])
    expect(edgeKindFrom('loop', 'ok')).toBe('met')
    expect(edgeKindFrom('loop', 'fail')).toBe('limit')
    expect(edgeKindFrom('instruction', 'limit')).toBe('fail')
    expect(edgeKindFrom('trigger', 'ok')).toBe('then')
    const mixed: Flow = { ...base(), edges: [e('lp', 'c', 'ok'), e('b', 'c', 'met')] }
    expect(frameEdges(mixed).edges.map((x) => x.kind)).toEqual(['met', 'ok'])
  })

  it('heads the frame with its name, criterion and limit, and the live round', () => {
    const f = loop(base(), 'lp')
    expect(frameHeader(f)).toBe('↻ Loop · until npm test passes · max 10')
    expect(frameHeader({ ...f, check: { ...f.check, command: '' }, agentDone: { on: true, goal: 'g' } })).toBe(
      '↻ Loop · until the agent says done · max 10',
    )
    const v: LoopView = {
      id: 'lp',
      name: 'Loop',
      state: 'open',
      iteration: 3,
      max: 10,
      startedAt: 0,
      minutes: 0,
      reason: null,
      endedAt: null,
      lastCheck: { ran: true, passed: false, said: false, tail: '', at: 1 },
    }
    expect(frameLive(v)).toBe('3/10 · last check failed')
    expect(frameLive({ ...v, state: 'limit', reason: 'hit 10 iterations' })).toBe('hit 10 iterations')
  })
})
