// md-mute: reads the meeting app's own Mute / Unmute control through Accessibility, so a
// recording can leave the microphone out while you are muted (Meetings, issue #102).
//
// Protocol (shared/meetingMute.ts is the other side):
//   stdin, once: one line of JSON rules  {"apps":[{"id","bundles","chromium"?,"menu"?|"element"?}]}
//   stdout, every 400 ms: one line      {"t":<ms>,"trusted":bool,"apps":[{"id","state"}]}
//   state is "muted", "unmuted" or "unknown"; only apps with a running process are listed.
// It exits when stdin closes or the parent goes away. Bad rules: a message on stderr, exit 2.
//
// What it may do, and nothing else: ask AXIsProcessTrusted() (never the prompting variant: the app
// asks, after consent), list running apps by bundle id, walk the role and children of the meeting
// app's windows or menu bar, and read the label attributes the rules name on controls of the
// rule's role. It never reads text content or keystrokes, and never presses anything. For
// Chromium browsers it sets AXManualAccessibility on the app element, as screen readers do, so
// the web page's controls are exposed.

import AppKit
import ApplicationServices
import Foundation

struct MenuRule: Decodable {
  let title: String
  let muted: [String]
  let unmuted: [String]
}

struct ElementRule: Decodable {
  let role: String
  let attrs: [String]
  let muted: [String]
  let unmuted: [String]
  /** Labels that start with one of these are never the user's own control ("Mute all"). */
  let exclude: [String]?
  /**
   * Prefixes among muted / unmuted that match only the whole label or the label followed by " ("
   * (a shortcut: "Mute (⌘+Shift+M)"), so a bare "Mute" never reads "Mute Alice".
   */
  let whole: [String]?
}

struct AppRule: Decodable {
  let id: String
  let bundles: [String]
  /** Bundle ids to set AXManualAccessibility on (Chromium browsers). */
  let chromium: [String]?
  let menu: MenuRule?
  let element: ElementRule?
}

struct Rules: Decodable {
  let apps: [AppRule]
}

struct AppState: Encodable {
  let id: String
  let state: String
}

struct Line: Encodable {
  let t: Int64
  let trusted: Bool
  let apps: [AppState]
}

// Caps: a search past any of them gives "unknown" rather than holding the line up.
let maxDepth = 60
let maxElements = 6000
let searchBudgetNs: UInt64 = 150_000_000
// One AX call to a busy app may not hang the helper. Set on the system-wide element, it is the
// default for every element (an app element's own timeout does not reach its children).
let messagingTimeout: Float = 0.05
let tickSeconds = 0.4
// A control found once is re-read each tick (its labels only); a full search again at once when
// it no longer reads, then, while searches keep failing, at most this often per process.
let researchSeconds = 2.0

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_DFL)
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), messagingTimeout)

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write(("md-mute: " + msg + "\n").data(using: .utf8)!)
  exit(2)
}

guard let first = readLine(strippingNewline: true) else { fail("no rules on stdin") }
let rules: Rules
do {
  rules = try JSONDecoder().decode(Rules.self, from: Data(first.utf8))
} catch {
  fail("rules are not valid: \(error)")
}
for r in rules.apps where r.menu == nil && r.element == nil {
  fail("rule \(r.id) has neither menu nor element")
}

let parent = getppid()

// stdin closing (the app quit, or MuteWatch let go) ends the helper.
Thread.detachNewThread {
  while readLine(strippingNewline: false) != nil {}
  exit(0)
}

func norm(_ s: String) -> String {
  s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

/**
 * nil when the label starts with an exclude prefix or none of the rule's; else the side whose
 * matching prefix is the longest (the most specific), muted on a tie. A prefix listed in `whole`
 * matches only the whole label or the label followed by " (". Keep it the same as classifyLabel
 * in shared/meetingMute.ts (its tests are this function's).
 */
func classify(_ label: String, muted: [String], unmuted: [String], exclude: [String] = [], whole: [String] = []) -> String? {
  let l = norm(label)
  if l.isEmpty { return nil }
  for p in exclude {
    let n = norm(p)
    if !n.isEmpty && l.hasPrefix(n) { return nil }
  }
  let wholeSet = Set(whole.map(norm))
  func matches(_ n: String) -> Bool {
    if wholeSet.contains(n) { return l == n || l.hasPrefix(n + " (") }
    return l.hasPrefix(n)
  }
  func best(_ ps: [String]) -> Int {
    var len = 0
    for p in ps {
      let n = norm(p)
      if !n.isEmpty && matches(n) && n.count > len { len = n.count }
    }
    return len
  }
  let m = best(muted)
  let u = best(unmuted)
  if m == 0 && u == 0 { return nil }
  return m >= u ? "muted" : "unmuted"
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
  return v
}

func string(_ el: AXUIElement, _ name: String) -> String? {
  attr(el, name) as? String
}

func children(_ el: AXUIElement, _ name: String = kAXChildrenAttribute as String) -> [AXUIElement] {
  (attr(el, name) as? [AXUIElement]) ?? []
}

struct Budget {
  let deadline: UInt64
  var seen = 0
  init() { deadline = DispatchTime.now().uptimeNanoseconds + searchBudgetNs }
  mutating func spend() -> Bool {
    seen += 1
    return seen <= maxElements && DispatchTime.now().uptimeNanoseconds < deadline
  }
}

/** The rule's menu item in the menu bar menu it names, and what its title says. */
func searchMenu(_ app: AXUIElement, _ rule: MenuRule) -> (String, AXUIElement)? {
  var budget = Budget()
  guard let bar = attr(app, kAXMenuBarAttribute as String), CFGetTypeID(bar) == AXUIElementGetTypeID() else {
    return nil
  }
  let barEl = bar as! AXUIElement  // checked by its type id above
  for top in children(barEl) {
    guard budget.spend() else { return nil }
    guard let t = string(top, kAXTitleAttribute as String), norm(t) == norm(rule.title) else { continue }
    for menu in children(top) {
      for item in children(menu) {
        guard budget.spend() else { return nil }
        if let title = string(item, kAXTitleAttribute as String),
           let s = classify(title, muted: rule.muted, unmuted: rule.unmuted) {
          return (s, item)
        }
      }
    }
    return nil
  }
  return nil
}

/**
 * One control's labels (the rule's attributes, in order): nil when any of them is excluded (a
 * "Mute all" is never the user's own control, whatever its other labels say), else the first
 * label that classifies. classifyControl in shared/meetingMute.ts is the same.
 */
func classifyControl(_ labels: [String], _ rule: ElementRule) -> String? {
  let ex = (rule.exclude ?? []).map(norm).filter { !$0.isEmpty }
  for label in labels {
    let l = norm(label)
    if ex.contains(where: { l.hasPrefix($0) }) { return nil }
  }
  for label in labels {
    if let s = classify(label, muted: rule.muted, unmuted: rule.unmuted, whole: rule.whole ?? []) { return s }
  }
  return nil
}

/** A control of the rule's role and what its labels say, or nil. */
func readControl(_ el: AXUIElement, _ rule: ElementRule) -> String? {
  guard string(el, kAXRoleAttribute as String) == rule.role else { return nil }
  return classifyControl(rule.attrs.compactMap { string(el, $0) }, rule)
}

/** A breadth-first walk of the app's windows for the first control of the rule's role and label. */
func searchElement(_ app: AXUIElement, _ rule: ElementRule) -> (String, AXUIElement)? {
  var budget = Budget()
  var level: [AXUIElement] = children(app, kAXWindowsAttribute as String)
  var depth = 0
  while !level.isEmpty && depth < maxDepth {
    var next: [AXUIElement] = []
    for el in level {
      guard budget.spend() else { return nil }
      if let s = readControl(el, rule) { return (s, el) }
      next.append(contentsOf: children(el))
    }
    level = next
    depth += 1
  }
  return nil
}

/** One rule set, read every tick. A class, so the run loop's timer holds no global state. */
final class Watcher {
  let rules: Rules
  let parent: pid_t
  /** Chromium processes already asked for their web content's tree (only for a rule sent). */
  var manualSet = Set<pid_t>()
  /** Per "rule id:pid": the control found last, re-read each tick (its labels only). */
  var found: [String: AXUIElement] = [:]
  /** Per "rule id:pid": when the last full search ran. */
  var searched: [String: Date] = [:]

  init(rules: Rules, parent: pid_t) {
    self.rules = rules
    self.parent = parent
  }

  /** The cached control's state, if it still reads. */
  func reread(_ el: AXUIElement, _ rule: AppRule) -> String? {
    if let m = rule.menu {
      guard let t = string(el, kAXTitleAttribute as String) else { return nil }
      return classify(t, muted: m.muted, unmuted: m.unmuted)
    }
    if let e = rule.element { return readControl(el, e) }
    return nil
  }

  func read(_ proc: NSRunningApplication, _ rule: AppRule) -> String {
    let pid = proc.processIdentifier
    let key = "\(rule.id):\(pid)"
    var lost = false
    if let el = found[key] {
      if let s = reread(el, rule) { return s }
      found[key] = nil
      lost = true
    }
    // The control that read last tick no longer does (rebuilt, moved): search again now, so a
    // mute shown a moment ago is not reported unknown for 2 s. Only failed searches in a row are
    // throttled, to one every researchSeconds per process (unknown in between).
    if !lost, let last = searched[key], Date().timeIntervalSince(last) < researchSeconds { return "unknown" }
    searched[key] = Date()
    let app = AXUIElementCreateApplication(pid)
    if let b = proc.bundleIdentifier, rule.chromium?.contains(b) == true, !manualSet.contains(pid) {
      // Chromium builds its tree for web content only when asked; the next searches see it. It
      // stays on until that browser quits (OPERATIONS § Meetings: md-mute).
      _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
      manualSet.insert(pid)
    }
    var hit: (String, AXUIElement)? = nil
    if let m = rule.menu {
      hit = searchMenu(app, m)
    } else if let e = rule.element {
      hit = searchElement(app, e)
    }
    guard let (s, el) = hit else { return "unknown" }
    found[key] = el
    return s
  }

  func tick() {
    if getppid() != parent { exit(0) }
    let trusted = AXIsProcessTrusted()
    let running = NSWorkspace.shared.runningApplications
    var out: [AppState] = []
    for rule in rules.apps {
      let procs = running.filter { p in p.bundleIdentifier.map { rule.bundles.contains($0) } ?? false }
      if procs.isEmpty { continue }
      var state = "unknown"
      if trusted {
        for p in procs {
          let s = read(p, rule)
          if s != "unknown" { state = s; break }
        }
      }
      out.append(AppState(id: rule.id, state: state))
    }
    // What belonged to processes that are gone.
    let live = Set(running.map { $0.processIdentifier })
    let alive = { (k: String) -> Bool in
      guard let p = k.split(separator: ":").last, let pid = pid_t(p) else { return false }
      return live.contains(pid)
    }
    manualSet = manualSet.filter { live.contains($0) }
    found = found.filter { alive($0.key) }
    searched = searched.filter { alive($0.key) }
    let line = Line(t: Int64(Date().timeIntervalSince1970 * 1000), trusted: trusted, apps: out)
    if let data = try? JSONEncoder().encode(line), let s = String(data: data, encoding: .utf8) {
      print(s)
    }
  }
}

let watcher = Watcher(rules: rules, parent: parent)
autoreleasepool { watcher.tick() }
// The timer fires on the main run loop, the only thread that touches the watcher.
let timer = Timer(timeInterval: tickSeconds, repeats: true) { _ in autoreleasepool { watcher.tick() } }
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
