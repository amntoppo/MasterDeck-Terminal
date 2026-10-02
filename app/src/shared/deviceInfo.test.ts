import { describe, expect, it } from 'vitest'
import { deviceFrom } from './deviceInfo'

const ua = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  ffLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
}

describe('deviceFrom', () => {
  it('parses common user agents', () => {
    expect(deviceFrom(ua.chromeMac)).toBe('Chrome on macOS')
    expect(deviceFrom(ua.safariIos)).toBe('Safari on iOS')
    expect(deviceFrom(ua.edgeWin)).toBe('Edge on Windows')
    expect(deviceFrom(ua.ffLinux)).toBe('Firefox on Linux')
    expect(deviceFrom(ua.chromeAndroid)).toBe('Chrome on Android')
    expect(deviceFrom(ua.safariMac)).toBe('Safari on macOS')
  })
  it('prefers userAgentData platform when given', () => {
    expect(deviceFrom(ua.chromeMac, 'Windows')).toBe('Chrome on Windows')
  })
  it('degrades, strips control chars and caps at 80', () => {
    expect(deviceFrom('')).toBeNull()
    expect(deviceFrom('curl/8')).toBeNull()
    expect(deviceFrom(ua.chromeMac, 'Mac\u0000OS\n' + 'x'.repeat(200))!.length).toBeLessThanOrEqual(80)
    expect(deviceFrom(ua.chromeMac, 'Mac\u0000OS')).not.toMatch(/\p{Cc}/u)
  })
})
