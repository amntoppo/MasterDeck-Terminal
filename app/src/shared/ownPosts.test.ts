import { describe, expect, it } from 'vitest'
import { isOwnPost, newOwnPostScan, OWN_MAX, scanOwnPosts } from './ownPosts'

const use = (input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input }] } })
const result = (text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] } })

describe('own posts', () => {
  it("finds a reply in the session's gh call, through shell escapes and rewrapping", () => {
    const scan = newOwnPostScan()
    // As the #147 session posted it: backticks and quotes escaped inside a double-quoted -f body.
    scanOwnPosts([use({ command: 'gh api -X POST repos/acme/web/pulls/1/comments/9/replies -f body="Fixed in ac0545c. Now \\`itemTarget()\\` in \\"notifications.ts\\"." --jq .id' })], scan)
    expect(isOwnPost('Fixed in ac0545c. Now `itemTarget()` in "notifications.ts".', scan)).toBe(true)
    expect(isOwnPost('Fixed in ac0545c.\r\nNow `itemTarget()`\nin "notifications.ts".', scan)).toBe(true)
  })
  it('a body file the session wrote counts; text it only read (a tool result) does not', () => {
    const scan = newOwnPostScan()
    scanOwnPosts([use({ file_path: '/tmp/body.md', content: '## Self-review\n\nAll good.' }), result('reviewer: please rename this')], scan)
    expect(isOwnPost('## Self-review\n\nAll good.', scan)).toBe(true)
    expect(isOwnPost('please rename this', scan)).toBe(false)
  })
  it("a review the user (or a review session as the user) wrote is not the session's", () => {
    const scan = newOwnPostScan()
    scanOwnPosts([use({ command: 'git push' }), 'not json', '{"type":"tool_use"'], scan)
    expect(isOwnPost('**Bug:** the target drops itemId when the cell is off.', scan)).toBe(false)
    expect(isOwnPost('   ', scan)).toBe(true)
  })
  it('keeps the newest text up to its cap', () => {
    const scan = newOwnPostScan()
    scanOwnPosts([use({ command: 'gh pr comment 1 --body "first reply"' })], scan)
    scanOwnPosts([use({ command: 'x'.repeat(OWN_MAX) })], scan)
    scanOwnPosts([use({ command: 'gh pr comment 1 --body "last reply"' })], scan)
    expect(scan.text.length).toBeLessThanOrEqual(OWN_MAX)
    expect(isOwnPost('first reply', scan)).toBe(false)
    expect(isOwnPost('last reply', scan)).toBe(true)
  })
})
