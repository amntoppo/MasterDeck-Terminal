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
// One AX call to a busy app may not hang the helper.
let messagingTimeout: Float = 0.05
let tickSeconds = 0.4

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_DFL)

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

/** "muted" / "unmuted" when the label starts with one of the rule's prefixes, else nil. */
func classify(_ label: String, muted: [String], unmuted: [String]) -> String? {
  let l = norm(label)
  if l.isEmpty { return nil }
  // Muted first: "Unmute" must not be read by a looser "Mute" written the other way round.
  for p in muted where !p.isEmpty && l.hasPrefix(norm(p)) { return "muted" }
  for p in unmuted where !p.isEmpty && l.hasPrefix(norm(p)) { return "unmuted" }
  return nil
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

/** The menu bar menu named by the rule, its items' titles. */
func readMenu(_ app: AXUIElement, _ rule: MenuRule) -> String {
  var budget = Budget()
  guard let bar = attr(app, kAXMenuBarAttribute as String), CFGetTypeID(bar) == AXUIElementGetTypeID() else {
    return "unknown"
  }
  let barEl = bar as! AXUIElement  // checked by its type id above
  for top in children(barEl) {
    guard budget.spend() else { return "unknown" }
    guard let t = string(top, kAXTitleAttribute as String), norm(t) == norm(rule.title) else { continue }
    for menu in children(top) {
      for item in children(menu) {
        guard budget.spend() else { return "unknown" }
        if let title = string(item, kAXTitleAttribute as String),
           let s = classify(title, muted: rule.muted, unmuted: rule.unmuted) {
          return s
        }
      }
    }
    return "unknown"
  }
  return "unknown"
}

/** A breadth-first walk of the app's windows for the first control of the rule's role and label. */
func readElement(_ app: AXUIElement, _ rule: ElementRule) -> String {
  var budget = Budget()
  var level: [AXUIElement] = children(app, kAXWindowsAttribute as String)
  var depth = 0
  while !level.isEmpty && depth < maxDepth {
    var next: [AXUIElement] = []
    for el in level {
      guard budget.spend() else { return "unknown" }
      if string(el, kAXRoleAttribute as String) == rule.role {
        for a in rule.attrs {
          if let label = string(el, a), let s = classify(label, muted: rule.muted, unmuted: rule.unmuted) {
            return s
          }
        }
      }
      next.append(contentsOf: children(el))
    }
    level = next
    depth += 1
  }
  return "unknown"
}

/** One rule set, read every tick. A class, so the run loop's timer holds no global state. */
final class Watcher {
  let rules: Rules
  let parent: pid_t
  /** Chromium processes already asked for their web content's tree. */
  var manualSet = Set<pid_t>()

  init(rules: Rules, parent: pid_t) {
    self.rules = rules
    self.parent = parent
  }

  func read(_ proc: NSRunningApplication, _ rule: AppRule) -> String {
    let app = AXUIElementCreateApplication(proc.processIdentifier)
    AXUIElementSetMessagingTimeout(app, messagingTimeout)
    if let b = proc.bundleIdentifier, rule.chromium?.contains(b) == true, !manualSet.contains(proc.processIdentifier) {
      // Chromium builds its tree for web content only when asked; the next ticks see it.
      _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
      manualSet.insert(proc.processIdentifier)
    }
    if let m = rule.menu { return readMenu(app, m) }
    if let e = rule.element { return readElement(app, e) }
    return "unknown"
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
    let live = Set(running.map { $0.processIdentifier })
    manualSet = manualSet.filter { live.contains($0) }
    let line = Line(t: Int64(Date().timeIntervalSince1970 * 1000), trusted: trusted, apps: out)
    if let data = try? JSONEncoder().encode(line), let s = String(data: data, encoding: .utf8) {
      print(s)
    }
  }
}

let watcher = Watcher(rules: rules, parent: parent)
watcher.tick()
// The timer fires on the main run loop, the only thread that touches the watcher.
let timer = Timer(timeInterval: tickSeconds, repeats: true) { _ in watcher.tick() }
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
