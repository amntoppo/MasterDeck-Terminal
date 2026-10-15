import { describe, expect, it } from 'vitest'
import { findUrls, isWebLink } from './termLinks'

const urls = (t: string) => findUrls(t).map((u) => u.url)

describe('findUrls', () => {
  it('finds local servers with ports, paths and queries', () => {
    expect(urls('  ➜  Local:   http://127.0.0.1:20060/')).toEqual(['http://127.0.0.1:20060/'])
    expect(urls('see http://127.0.0.1:20060/docs?x=1&y=2#top now')).toEqual(['http://127.0.0.1:20060/docs?x=1&y=2#top'])
    expect(urls('http://localhost:3000 and https://10.0.0.5:8443/a')).toEqual(['http://localhost:3000', 'https://10.0.0.5:8443/a'])
    expect(urls('ipv6 http://[::1]:8080/x')).toEqual(['http://[::1]:8080/x'])
  })

  it('gives the offsets of each address', () => {
    expect(findUrls('go to https://a.test/x.')).toEqual([{ url: 'https://a.test/x', start: 6, end: 22 }])
  })

  it('leaves out trailing punctuation and a closing bracket it did not open', () => {
    expect(urls('Open http://localhost:3000.')).toEqual(['http://localhost:3000'])
    expect(urls('one http://a.test/x, two')).toEqual(['http://a.test/x'])
    expect(urls('(at http://a.test/x)')).toEqual(['http://a.test/x'])
    expect(urls('[docs](https://a.test/page)')).toEqual(['https://a.test/page'])
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
    expect(urls('"https://a.test/q" and <https://b.test>')).toEqual(['https://a.test/q', 'https://b.test'])
  })

  it('stops at a TUI border', () => {
    expect(urls('│ http://localhost:5173/ │')).toEqual(['http://localhost:5173/'])
  })

  it('takes http and https only', () => {
    expect(urls('file:///etc/passwd javascript:alert(1) ftp://x.test mailto:a@b.test')).toEqual([])
    expect(urls('xhttp://a.test')).toEqual([])
    expect(urls('http://')).toEqual([])
  })
})

describe('isWebLink', () => {
  it('accepts http and https addresses', () => {
    expect(isWebLink('http://127.0.0.1:20060')).toBe(true)
    expect(isWebLink('HTTPS://a.test/x')).toBe(true)
  })

  it('refuses other schemes, spaces, control characters and long addresses', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'http://a b', 'http://a.test/\n', ' http://a.test', 'http://', 42, null, `https://a.test/${'x'.repeat(2100)}`])
      expect(isWebLink(u)).toBe(false)
  })
})
