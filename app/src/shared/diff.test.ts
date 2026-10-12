import { describe, expect, it } from 'vitest'
import { DIFF_MAX_LINES } from './fileView'
import { parseChanges, parseDiff, splitRows } from './diff'

const z = (...parts: string[]) => parts.join('\0') + '\0'

describe('parseChanges', () => {
  it('reads git diff --name-status -z and --numstat -z with untracked files', () => {
    const status = z('M', 'src/a.ts', 'A', 'new.md', 'D', 'gone.txt', 'R087', 'old/n.ts', 'new/n.ts', 'M', 'logo.png')
    const numstat = z('3\t1\tsrc/a.ts', '10\t0\tnew.md', '0\t4\tgone.txt', '2\t2\t', 'old/n.ts', 'new/n.ts', '-\t-\tlogo.png')
    const r = parseChanges(status, numstat, [{ path: 'scratch.txt', add: 7, binary: false }])
    expect(r).toEqual([
      { path: 'gone.txt', status: 'deleted', add: 0, del: 4, binary: false },
      { path: 'logo.png', status: 'modified', add: 0, del: 0, binary: true },
      { path: 'new.md', status: 'added', add: 10, del: 0, binary: false },
      { path: 'new/n.ts', oldPath: 'old/n.ts', status: 'renamed', add: 2, del: 2, binary: false },
      { path: 'scratch.txt', status: 'added', add: 7, del: 0, binary: false, untracked: true },
      { path: 'src/a.ts', status: 'modified', add: 3, del: 1, binary: false },
    ])
  })
  it('treats type changes and copies as modified / added, and survives empty output', () => {
    expect(parseChanges(z('T', 'l', 'C100', 'a', 'b'), z('0\t0\tl', '0\t0\t', 'a', 'b'), [])).toEqual([
      { path: 'b', oldPath: 'a', status: 'added', add: 0, del: 0, binary: false },
      { path: 'l', status: 'modified', add: 0, del: 0, binary: false },
    ])
    expect(parseChanges('', '', [])).toEqual([])
  })
})

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ export function f() {
 one
-two
+TWO
+two and a half
 three
 four
@@ -10,2 +11,2 @@
 ten
-eleven
\\ No newline at end of file
+eleven
`

describe('parseDiff', () => {
  it('reads hunks with line numbers', () => {
    const d = parseDiff(DIFF)
    expect(d.binary).toBe(false)
    expect(d.truncated).toBe(false)
    expect(d.hunks).toHaveLength(2)
    expect(d.hunks[0].header).toBe('@@ -1,4 +1,5 @@ export function f() {')
    expect(d.hunks[0].lines).toEqual([
      { kind: 'ctx', text: 'one', old: 1, new: 1 },
      { kind: 'del', text: 'two', old: 2 },
      { kind: 'add', text: 'TWO', new: 2 },
      { kind: 'add', text: 'two and a half', new: 3 },
      { kind: 'ctx', text: 'three', old: 3, new: 4 },
      { kind: 'ctx', text: 'four', old: 4, new: 5 },
    ])
    expect(d.hunks[1].lines).toEqual([
      { kind: 'ctx', text: 'ten', old: 10, new: 11 },
      { kind: 'del', text: 'eleven', old: 11, noNewline: true },
      { kind: 'add', text: 'eleven', new: 12 },
    ])
  })
  it('says when a file is binary', () => {
    const d = parseDiff('diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n')
    expect(d).toEqual({ binary: true, hunks: [], truncated: false })
  })
  it('cuts a very long diff', () => {
    const body = Array.from({ length: DIFF_MAX_LINES + 50 }, (_, i) => `+l${i}`).join('\n')
    const d = parseDiff(`--- /dev/null\n+++ b/x\n@@ -0,0 +1,${DIFF_MAX_LINES + 50} @@\n${body}\n`)
    expect(d.truncated).toBe(true)
    expect(d.hunks[0].lines).toHaveLength(DIFF_MAX_LINES)
  })
  it('reads only the first file of an answer that holds two', () => {
    const d = parseDiff(`${DIFF}diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-x\n+y\n`)
    expect(d.hunks).toHaveLength(2)
    expect(d.hunks.flatMap((h) => h.lines).some((l) => l.text === 'y')).toBe(false)
  })
  it('gives nothing for an empty diff', () => {
    expect(parseDiff('')).toEqual({ binary: false, hunks: [], truncated: false })
  })
})

describe('splitRows', () => {
  it('pairs removed lines with added ones', () => {
    const rows = splitRows(parseDiff(DIFF).hunks[0])
    expect(rows).toEqual([
      { left: { kind: 'ctx', text: 'one', old: 1, new: 1 }, right: { kind: 'ctx', text: 'one', old: 1, new: 1 } },
      { left: { kind: 'del', text: 'two', old: 2 }, right: { kind: 'add', text: 'TWO', new: 2 } },
      { left: null, right: { kind: 'add', text: 'two and a half', new: 3 } },
      { left: { kind: 'ctx', text: 'three', old: 3, new: 4 }, right: { kind: 'ctx', text: 'three', old: 3, new: 4 } },
      { left: { kind: 'ctx', text: 'four', old: 4, new: 5 }, right: { kind: 'ctx', text: 'four', old: 4, new: 5 } },
    ])
  })
  it('handles hunks with only adds or only dels', () => {
    const adds = parseDiff('@@ -0,0 +1,2 @@\n+a\n+b\n').hunks[0]
    expect(splitRows(adds).map((r) => [r.left, r.right?.text])).toEqual([[null, 'a'], [null, 'b']])
    const dels = parseDiff('@@ -1,2 +0,0 @@\n-a\n-b\n').hunks[0]
    expect(splitRows(dels).map((r) => [r.left?.text, r.right])).toEqual([['a', null], ['b', null]])
  })
})
