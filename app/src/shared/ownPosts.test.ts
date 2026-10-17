import { describe, expect, it } from 'vitest'
import { commandBodies, isOwnPost, newOwnPostScan, OWN_MAX, POSTS_MAX, scanOwnPosts } from './ownPosts'

const use = (input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input }] } })
const result = (text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] } })
const scanOf = (...lines: string[]) => {
  const scan = newOwnPostScan()
  scanOwnPosts(lines, scan)
  return scan
}

describe('own posts', () => {
  it("finds a reply in the session's gh call, through shell escapes and rewrapping", () => {
    // As the #147 session posted it: backticks and quotes escaped inside a double-quoted -f body.
    const scan = scanOf(use({ command: 'gh api -X POST repos/acme/web/pulls/1/comments/9/replies -f body="Fixed in ac0545c. Now \\`itemTarget()\\` in \\"notifications.ts\\"." --jq .id' }))
    expect(isOwnPost('Fixed in ac0545c. Now `itemTarget()` in "notifications.ts".', scan)).toBe(true)
    expect(isOwnPost('Fixed in ac0545c.\r\nNow `itemTarget()`\nin "notifications.ts".', scan)).toBe(true)
  })
  it('a body file the session wrote counts; text it only read (a tool result) does not', () => {
    const scan = scanOf(use({ file_path: '/tmp/body.md', content: '## Self-review\n\nAll good.' }), result('reviewer: please rename this'))
    expect(isOwnPost('## Self-review\n\nAll good.', scan)).toBe(true)
    expect(isOwnPost('please rename this', scan)).toBe(false)
  })
  it("a review the user (or a review session as the user) wrote is not the session's", () => {
    const scan = scanOf(use({ command: 'git push' }), 'not json', '{"type":"tool_use"')
    expect(isOwnPost('**Bug:** the target drops itemId when the cell is off.', scan)).toBe(false)
    expect(isOwnPost('   ', scan)).toBe(true)
  })
  it('a short comment counts only when the session posted exactly that, not when the word is in its work', () => {
    const scan = scanOf(
      use({ file_path: '/w/a.ts', old_string: 'const typo = 1', new_string: 'const fixed = 1' }),
      use({ command: 'grep -rn "nit" src; git commit -m "rename this and remove that"' }),
      use({ command: 'gh pr comment 3 --body "Done."' }),
    )
    for (const body of ['typo', 'nit', 'rename this', 'remove', 'LGTM']) expect(isOwnPost(body, scan)).toBe(false)
    expect(isOwnPost('Done.', scan)).toBe(true)
  })
  it('bodies the shell fills in ($(...), $VAR) and heredocs', () => {
    const scan = scanOf(
      use({ command: 'gh api repos/acme/web/pulls/1/comments/9/replies -f body="Fixed in $(git rev-parse --short HEAD)."' }),
      use({ command: "gh pr comment 2 --body \"$(cat <<'EOF'\nAddressed both threads:\n- the guard\n- the test\nEOF\n)\"" }),
      use({ command: 'gh pr comment 2 --body "$MSG"' }),
    )
    expect(isOwnPost('Fixed in 1a2b3c4.', scan)).toBe(true)
    expect(isOwnPost('Addressed both threads:\n- the guard\n- the test', scan)).toBe(true)
    // A body that is only a variable fits any text: it is not kept.
    expect(isOwnPost('Please add a test', scan)).toBe(false)
    expect(isOwnPost('The guard is not fixed in 1a2b3c4.', scan)).toBe(false)
  })
  it('reads the body flags gh takes', () => {
    expect(commandBodies(`gh pr review 1 --comment -b 'short'; gh pr comment 1 --body=x; gh api x -F body="y z"; gh api x --raw-field body='w'`)).toEqual(['short', 'x', 'y z', 'w'])
    expect(commandBodies('echo hi')).toEqual([])
  })
  it('keeps the newest text and posts up to their caps', () => {
    const long = (w: string) => `${w} ${'is a long sentence about the change '.repeat(3)}`
    const scan = scanOf(use({ command: `echo "${long('first')}"` }))
    scanOwnPosts([use({ command: 'x'.repeat(OWN_MAX) })], scan)
    scanOwnPosts([use({ command: `echo "${long('last')}"` })], scan)
    expect(scan.text.length).toBeLessThanOrEqual(OWN_MAX)
    expect(isOwnPost(long('first'), scan)).toBe(false)
    expect(isOwnPost(long('last'), scan)).toBe(true)
    scanOwnPosts(Array.from({ length: POSTS_MAX + 5 }, (_, i) => use({ command: `gh pr comment 1 --body "reply ${i}"` })), scan)
    expect(scan.posts).toHaveLength(POSTS_MAX)
    expect(isOwnPost('reply 0', scan)).toBe(false)
    expect(isOwnPost(`reply ${POSTS_MAX + 4}`, scan)).toBe(true)
  })
})
