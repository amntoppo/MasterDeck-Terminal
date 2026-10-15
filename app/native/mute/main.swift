// md-mute: reads the meeting app's own Mute / Unmute control through Accessibility, so a
// recording can leave the microphone out while you are muted (Meetings, issue #102).
//
// Protocol (shared/meetingMute.ts is the other side):
//   stdin, once: one line of JSON rules  {"apps":[{"id","bundles","chromium"?,"web"?,"hosts"?,"menu"?|"element"?}]}
//   stdout, every 400 ms: one line      {"t":<ms>,"trusted":bool,"apps":[{"id","state",<diagnostics>}]}
//   state is "muted", "unmuted" or "unknown"; only apps with a running process are listed.
//   Diagnostics (added later; readers before them ignore them): "why" ("found", "not-trusted",
//   "no-control", "cut", "error"), "label" (the matched control's label only, at most 80
//   characters, anything outside printable ASCII as "?"), "searched" (elements visited this tick;
//   0 when no search ran), "ms" (time spent this tick), "cached" (read from the control found
//   before).
// It exits when stdin closes or the parent goes away. Bad rules: a message on stderr, exit 2.
//
// What it may do, and nothing else: ask AXIsProcessTrusted() (never the prompting variant: the app
// asks, after consent), list running apps by bundle id, walk the role and children of the meeting
// app's windows or menu bar, and read the label attributes the rules name on controls of the
// rule's roles; for a web rule with hosts, a page's AXURL, only to compare its host (it never leaves
// the helper). It never reads text content or keystrokes, and never presses anything. For
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
  /** The control's roles ("AXButton", "AXCheckBox", …). `role` alone is the older form. */
  let roles: [String]?
  let role: String?
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

  var roleList: [String] { roles ?? (role.map { [$0] } ?? []) }
}

struct AppRule: Decodable {
  let id: String
  let bundles: [String]
  /** Bundle ids to set AXManualAccessibility on (Chromium browsers). */
  let chromium: [String]?
  /** A web page's control (a browser): searched from the windows' AXWebArea elements, with a larger budget. */
  let web: Bool?
  /** With web: only pages whose AXURL host is one of these (or below one) are searched. */
  let hosts: [String]?
  let menu: MenuRule?
  let element: ElementRule?
}

struct Rules: Decodable {
  let apps: [AppRule]
}

struct AppState: Encodable {
  let id: String
  let state: String
  let why: String
  let label: String?
  let searched: Int
  let ms: Int
  let cached: Bool
}

struct Line: Encodable {
  let t: Int64
  let trusted: Bool
  let apps: [AppState]
}

// Caps: a search past any of them gives "unknown" (why "cut") rather than holding the line up.
let maxDepth = 60
let maxElements = 6000
let searchBudgetNs: UInt64 = 150_000_000
// A browser's page is deep and wide (Meet's DOM): a larger budget, still searched at most every
// researchSeconds; a control found once is re-read cheaply.
let webMaxDepth = 150
let webMaxElements = 40_000
let webBudgetNs: UInt64 = 800_000_000
let labelMax = 80
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
for r in rules.apps where r.element != nil && r.element!.roleList.isEmpty {
  fail("rule \(r.id) has no role")
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

/** A label as it may leave the helper: trimmed, printable ASCII ("?" for anything else), at most labelMax. */
func safeLabel(_ s: String) -> String {
  var out = ""
  for u in s.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars {
    if out.count >= labelMax { break }
    out.append(u.value >= 0x20 && u.value < 0x7f ? Character(u) : "?")
  }
  return out
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

/** An attribute's value, or nil with the error (nil error: there is none to read). */
func attrErr(_ el: AXUIElement, _ name: String) -> (CFTypeRef?, AXError) {
  var v: CFTypeRef?
  let e = AXUIElementCopyAttributeValue(el, name as CFString, &v)
  return (e == .success ? v : nil, e)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  attrErr(el, name).0
}

func string(_ el: AXUIElement, _ name: String) -> String? {
  attr(el, name) as? String
}

func children(_ el: AXUIElement, _ name: String = kAXChildrenAttribute as String) -> [AXUIElement] {
  (attr(el, name) as? [AXUIElement]) ?? []
}

/** The app did not answer, or refused: not the same as "nothing there". */
func isFailure(_ e: AXError) -> Bool {
  e == .cannotComplete || e == .apiDisabled || e == .failure || e == .invalidUIElement || e == .notImplemented
}

/**
 * A failure during a walk: the app did not answer or refused. An element that went away while
 * the page redrew (invalidUIElement) is part of a live tree, not a failure.
 */
func isWalkFailure(_ e: AXError) -> Bool {
  e != .invalidUIElement && isFailure(e)
}

struct Budget {
  let deadline: UInt64
  let max: Int
  var seen = 0
  var cut = false
  /** An AX read failed somewhere (isWalkFailure): a search that then finds nothing says "error". */
  var failed = false
  init(elements: Int = maxElements, ns: UInt64 = searchBudgetNs) {
    deadline = DispatchTime.now().uptimeNanoseconds + ns
    max = elements
  }
  mutating func spend() -> Bool {
    seen += 1
    if seen <= max && DispatchTime.now().uptimeNanoseconds < deadline { return true }
    cut = true
    return false
  }

  /** An element's children; a failed read is noted, and counts as none. */
  mutating func kids(_ el: AXUIElement) -> [AXUIElement] {
    let (v, e) = attrErr(el, kAXChildrenAttribute as String)
    if isWalkFailure(e) { failed = true }
    return (v as? [AXUIElement]) ?? []
  }

  /** An element's role; a failed read is noted. */
  mutating func role(_ el: AXUIElement) -> String? {
    let (v, e) = attrErr(el, kAXRoleAttribute as String)
    if isWalkFailure(e) { failed = true }
    return v as? String
  }
}

/** What one search found: the control, its state and label, or why not. */
struct Search {
  var state = "unknown"
  var why = "no-control"
  var label: String? = nil
  var el: AXUIElement? = nil
  var searched = 0
}

/** The rule's menu item in the menu bar menu it names, and what its title says. */
func searchMenu(_ app: AXUIElement, _ rule: MenuRule) -> Search {
  var budget = Budget()
  var out = Search()
  defer { out.searched = budget.seen }
  let (bar, err) = attrErr(app, kAXMenuBarAttribute as String)
  guard let bar = bar, CFGetTypeID(bar) == AXUIElementGetTypeID() else {
    out.why = isFailure(err) ? "error" : "no-control"
    return out
  }
  let barEl = bar as! AXUIElement  // checked by its type id above
  for top in budget.kids(barEl) {
    guard budget.spend() else { out.why = "cut"; return out }
    guard let t = string(top, kAXTitleAttribute as String), norm(t) == norm(rule.title) else { continue }
    for menu in budget.kids(top) {
      for item in budget.kids(menu) {
        guard budget.spend() else { out.why = "cut"; return out }
        if let title = string(item, kAXTitleAttribute as String),
           let s = classify(title, muted: rule.muted, unmuted: rule.unmuted) {
          out.state = s
          out.why = "found"
          out.label = safeLabel(title)
          out.el = item
          return out
        }
      }
    }
    if budget.failed { out.why = "error" }
    return out
  }
  if budget.failed { out.why = "error" }
  return out
}

/**
 * One control's labels (the rule's attributes, in order): nil when any of them is excluded (a
 * "Mute all" is never the user's own control, whatever its other labels say), else the first
 * label that classifies, with that label. classifyControl in shared/meetingMute.ts is the same.
 */
func classifyControl(_ labels: [String], _ rule: ElementRule) -> (String, String)? {
  let ex = (rule.exclude ?? []).map(norm).filter { !$0.isEmpty }
  for label in labels {
    let l = norm(label)
    if ex.contains(where: { l.hasPrefix($0) }) { return nil }
  }
  for label in labels {
    if let s = classify(label, muted: rule.muted, unmuted: rule.unmuted, whole: rule.whole ?? []) { return (s, label) }
  }
  return nil
}

/** A control of one of the rule's roles and what its labels say (state, the label that said it), or nil. */
func readControl(_ el: AXUIElement, _ rule: ElementRule) -> (String, String)? {
  guard let role = string(el, kAXRoleAttribute as String) else { return nil }
  return readControl(el, role: role, rule)
}

func readControl(_ el: AXUIElement, role: String, _ rule: ElementRule) -> (String, String)? {
  guard rule.roleList.contains(role) else { return nil }
  return classifyControl(rule.attrs.compactMap { string(el, $0) }, rule)
}

/** A page's host, from its AXURL (a URL or a string), lowercased; nil when it has none. */
func pageHost(_ el: AXUIElement) -> String? {
  guard let v = attr(el, "AXURL") else { return nil }
  if CFGetTypeID(v) == CFURLGetTypeID() { return (v as! URL).host?.lowercased() }  // checked by its type id
  if let s = v as? String { return URL(string: s)?.host?.lowercased() }
  return nil
}

/** The host is one of `hosts` or below one ("meet.google.com" covers "x.meet.google.com"). */
func hostMatches(_ host: String, _ hosts: [String]) -> Bool {
  hosts.contains { h in
    let n = norm(h)
    return !n.isEmpty && (host == n || host.hasSuffix("." + n))
  }
}

/**
 * A breadth-first walk for the first control of the rule's roles and label: from the app's
 * windows, or, for a web page (`web`), from the windows' AXWebArea elements, found first by a walk
 * that does not go into them, nor into toolbars (and, in a Chromium browser, the tab strip's
 * AXTabGroup): the browser's own controls are never searched. With `hosts`, only pages on them.
 */
func searchElement(_ app: AXUIElement, _ rule: ElementRule, web: Bool, hosts: [String]?, chromium: Bool) -> Search {
  var budget = web ? Budget(elements: webMaxElements, ns: webBudgetNs) : Budget()
  var out = Search()
  defer { out.searched = budget.seen }
  let (wins, err) = attrErr(app, kAXWindowsAttribute as String)
  if wins == nil && isFailure(err) {
    out.why = "error"
    return out
  }
  var level: [AXUIElement] = (wins as? [AXUIElement]) ?? []
  var depth = 0
  if web {
    var areas: [AXUIElement] = []
    while !level.isEmpty && depth < maxDepth {
      var next: [AXUIElement] = []
      for el in level {
        guard budget.spend() else { out.why = "cut"; return out }
        let role = budget.role(el)
        if role == "AXWebArea" {
          // One AXURL read per page found; a page without one is not a call's.
          if let hs = hosts, !hs.isEmpty {
            if let h = pageHost(el), hostMatches(h, hs) { areas.append(el) }
          } else {
            areas.append(el)
          }
        } else if role == "AXToolbar" || (chromium && role == "AXTabGroup") {
          // The browser's own controls. Safari keeps its pages inside an AXTabGroup, so only
          // Chromium's (the tab strip) is skipped.
          continue
        } else {
          next.append(contentsOf: budget.kids(el))
        }
      }
      level = next
      depth += 1
    }
    // No page (on the rule's hosts) in any window, or Chromium has not built its tree yet.
    if areas.isEmpty {
      if budget.failed { out.why = "error" }
      return out
    }
    level = areas
    depth = 0
  }
  let limit = web ? webMaxDepth : maxDepth
  while !level.isEmpty && depth < limit {
    var next: [AXUIElement] = []
    for el in level {
      guard budget.spend() else { out.why = "cut"; return out }
      if let role = budget.role(el), let (s, label) = readControl(el, role: role, rule) {
        out.state = s
        out.why = "found"
        out.label = safeLabel(label)
        out.el = el
        return out
      }
      next.append(contentsOf: budget.kids(el))
    }
    level = next
    depth += 1
  }
  // The walk ended without the control but some reads failed: the app did not answer, not "no
  // control" (the part it did not answer for may hold it).
  if budget.failed { out.why = "error" }
  return out
}

func elapsedMs(_ since: UInt64) -> Int {
  Int((DispatchTime.now().uptimeNanoseconds - since) / 1_000_000)
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
  /** Per "rule id:pid": why the last full search found nothing (said again on the ticks between searches). */
  var lastWhy: [String: String] = [:]
  /**
   * "rule id:pid" whose first search ran right after AXManualAccessibility was set and found
   * nothing: Chromium may not have built the page's tree yet, so the next tick searches again
   * without waiting researchSeconds (once).
   */
  var retryOnce = Set<String>()

  init(rules: Rules, parent: pid_t) {
    self.rules = rules
    self.parent = parent
  }

  /** The cached control's state and label, if it still reads. */
  func reread(_ el: AXUIElement, _ rule: AppRule) -> (String, String)? {
    if let m = rule.menu {
      guard let t = string(el, kAXTitleAttribute as String), let s = classify(t, muted: m.muted, unmuted: m.unmuted) else { return nil }
      return (s, t)
    }
    if let e = rule.element { return readControl(el, e) }
    return nil
  }

  func read(_ proc: NSRunningApplication, _ rule: AppRule) -> AppState {
    let start = DispatchTime.now().uptimeNanoseconds
    let pid = proc.processIdentifier
    let key = "\(rule.id):\(pid)"
    var lost = false
    if let el = found[key] {
      if let (s, label) = reread(el, rule) {
        return AppState(id: rule.id, state: s, why: "found", label: safeLabel(label), searched: 1, ms: elapsedMs(start), cached: true)
      }
      found[key] = nil
      lost = true
    }
    // The control that read last tick no longer does (rebuilt, moved): search again now, so a
    // mute shown a moment ago is not reported unknown for 2 s. Only failed searches in a row are
    // throttled, to one every researchSeconds per process (unknown in between, with the last
    // search's why).
    let retry = retryOnce.remove(key) != nil
    if !lost, !retry, let last = searched[key], Date().timeIntervalSince(last) < researchSeconds {
      return AppState(id: rule.id, state: "unknown", why: lastWhy[key] ?? "no-control", label: nil, searched: 0, ms: 0, cached: false)
    }
    searched[key] = Date()
    let app = AXUIElementCreateApplication(pid)
    var justSet = false
    if let b = proc.bundleIdentifier, rule.chromium?.contains(b) == true, !manualSet.contains(pid) {
      // Chromium builds its tree for web content only when asked; the next searches see it. It
      // stays on until that browser quits (OPERATIONS § Meetings: md-mute). Only a set that
      // worked is remembered: a busy browser is asked again at the next search.
      if AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
        manualSet.insert(pid)
        justSet = true
      }
    }
    var hit = Search()
    if let m = rule.menu {
      hit = searchMenu(app, m)
    } else if let e = rule.element {
      let chromium = proc.bundleIdentifier.map { rule.chromium?.contains($0) == true } ?? false
      hit = searchElement(app, e, web: rule.web == true, hosts: rule.hosts, chromium: chromium)
    }
    let ms = elapsedMs(start)
    guard let el = hit.el else {
      lastWhy[key] = hit.why
      if justSet { retryOnce.insert(key) }
      return AppState(id: rule.id, state: "unknown", why: hit.why, label: nil, searched: hit.searched, ms: ms, cached: false)
    }
    found[key] = el
    lastWhy[key] = nil
    return AppState(id: rule.id, state: hit.state, why: "found", label: hit.label, searched: hit.searched, ms: ms, cached: false)
  }

  /** Several processes of one rule (two browsers): the first that reads; else the most telling why. */
  func merge(_ id: String, _ states: [AppState]) -> AppState {
    if let f = states.first(where: { $0.state != "unknown" }) { return f }
    let order = ["cut", "error", "no-control"]
    let why = order.first(where: { w in states.contains { $0.why == w } }) ?? "no-control"
    return AppState(
      id: id, state: "unknown", why: why, label: nil,
      searched: states.reduce(0) { $0 + $1.searched }, ms: states.reduce(0) { $0 + $1.ms }, cached: false)
  }

  func tick() {
    if getppid() != parent { exit(0) }
    let trusted = AXIsProcessTrusted()
    let running = NSWorkspace.shared.runningApplications
    var out: [AppState] = []
    for rule in rules.apps {
      let all = running.filter { p in p.bundleIdentifier.map { rule.bundles.contains($0) } ?? false }
      if all.isEmpty { continue }
      // A process whose control was found before goes first: it is re-read cheaply, and while it
      // reads the others are not searched.
      let cached = all.filter { found["\(rule.id):\($0.processIdentifier)"] != nil }
      let procs = cached + all.filter { found["\(rule.id):\($0.processIdentifier)"] == nil }
      if !trusted {
        out.append(AppState(id: rule.id, state: "unknown", why: "not-trusted", label: nil, searched: 0, ms: 0, cached: false))
        continue
      }
      var states: [AppState] = []
      for p in procs {
        let s = read(p, rule)
        states.append(s)
        if s.state != "unknown" { break }
      }
      out.append(merge(rule.id, states))
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
    lastWhy = lastWhy.filter { alive($0.key) }
    retryOnce = retryOnce.filter { alive($0) }
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
