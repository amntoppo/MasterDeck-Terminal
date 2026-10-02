const clean = (s: string) => [...s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, 80).join('')

/** "Chrome on macOS" from a user agent (and the userAgentData platform when the browser has one); null when unknown. */
export function deviceFrom(userAgent: string, platform?: string): string | null {
  const u = userAgent || ''
  const browser = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\/|CriOS\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : null
  const os = /iPhone|iPad|iPod/.test(u) ? 'iOS' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /CrOS/.test(u) ? 'ChromeOS' : /Linux|X11/.test(u) ? 'Linux' : null
  const p = platform ? clean(platform) : ''
  const where = p || os
  if (!browser && !where) return null
  return clean(browser && where ? `${browser} on ${where}` : (browser ?? where)!)
}
