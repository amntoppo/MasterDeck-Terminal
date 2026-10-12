import { describe, expect, it } from 'vitest'
import { callApps, offerText } from './meetingApps'

// `ps -axo comm` on macOS: a header, then one executable path per line.
const IDLE = `COMM
/sbin/launchd
/usr/libexec/logd
/Applications/zoom.us.app/Contents/MacOS/zoom.us
/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams
/Applications/Slack.app/Contents/MacOS/Slack
/Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer)
/Applications/Webex.app/Contents/MacOS/Webex
`
const ZOOM_CALL = `${IDLE}/Applications/zoom.us.app/Contents/Frameworks/CptHost.app/Contents/MacOS/CptHost
/Applications/zoom.us.app/Contents/Frameworks/aomhost.app/Contents/MacOS/aomhost
`

describe('callApps', () => {
  it('nothing while the apps are only open', () => {
    expect(callApps(IDLE)).toEqual([])
    expect(callApps('')).toEqual([])
    expect(callApps('COMM\n')).toEqual([])
  })

  it('Zoom in a meeting by its CptHost or aomhost, once', () => {
    expect(callApps(ZOOM_CALL)).toEqual(['Zoom'])
    expect(callApps(`${IDLE}/Users/alice/Applications/zoom.us.app/Contents/Frameworks/aomhost.app/Contents/MacOS/aomhost\n`)).toEqual(['Zoom'])
  })

  it('Webex in a meeting by its Meeting Center; both apps in MEETING_APPS order', () => {
    const webex = `${IDLE}/Users/alice/Library/Application Support/WebEx Folder/T33_64UMC_43.6/Meeting Center.app/Contents/MacOS/Meeting Center\n`
    expect(callApps(webex)).toEqual(['Webex'])
    expect(callApps(`${webex}/Applications/zoom.us.app/Contents/Frameworks/CptHost.app/Contents/MacOS/CptHost\n`)).toEqual(['Zoom', 'Webex'])
  })

  it('a process with the same name outside the app does not count', () => {
    expect(callApps(`${IDLE}/tmp/CptHost\n/usr/local/bin/aomhost\n/Applications/Other.app/Contents/MacOS/Meeting Center\n`)).toEqual([])
    // The name must be the executable's own, not part of a folder.
    expect(callApps(`${IDLE}/Applications/zoom.us.app/Contents/Frameworks/CptHost.app/Contents/MacOS/CptHostHelper\n`)).toEqual([])
  })

  it('surrounding spaces and Windows line ends are tolerated', () => {
    expect(callApps('COMM\r\n  /Applications/zoom.us.app/Contents/Frameworks/CptHost.app/Contents/MacOS/CptHost  \r\n')).toEqual(['Zoom'])
  })
})

describe('offerText', () => {
  it('says which app', () => {
    expect(offerText('Zoom')).toBe('Zoom call: record it?')
  })
})
