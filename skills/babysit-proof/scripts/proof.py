#!/usr/bin/env python3
"""babysit-proof: run a session's end-to-end tests once, keep a screenshot of every step, and post
a summary with the screenshots on the session's GitHub issue.

  proof.py init                         new run folder .proof/<stamp>/ in the worktree (git-ignored)
  proof.py fixture <dir>                copy proof.fixture.ts (Playwright: a screenshot per action)
  proof.py web [playwright args...]     npx playwright test, screenshots via the fixture
  proof.py expo <flow|dir> [--platform ios|android]
                                        maestro test while the simulator screen is recorded; one frame
                                        per step, cut at the moment the step finished
  proof.py changes                      what the session changed: commits, files, PRs -> changes.md
  proof.py publish [--issue N] [--dry-run]
                                        push the screenshots to the babysit-proof branch of origin and
                                        comment summary + screenshots on the linked issue

Every command works on the newest run folder (or --run DIR). Nothing is run twice: screenshots
are taken while the tests run, never by replaying steps.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path.home()
TT = HOME / ".claude" / "skills" / "babysit-ticket" / "scripts" / "tt.sh"
MASTER = HOME / ".claude" / "skills" / "master" / "master"
BRANCH = "babysit-proof"
MAX_IMAGES = 40  # in one issue comment; the rest are listed by name


def sh(cmd: list[str], cwd: Path | None = None, check: bool = True, env: dict | None = None, **kw) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, env=env, **kw)
    if check and r.returncode != 0:
        sys.exit(f"babysit-proof: {' '.join(cmd[:3])} failed: {(r.stderr or r.stdout).strip()[:500]}")
    return r


def repo_root() -> Path:
    return Path(sh(["git", "rev-parse", "--show-toplevel"]).stdout.strip())


def slug(s: str, n: int = 60) -> str:
    return re.sub(r"[^\w.-]+", "-", s).strip("-")[:n] or "step"


# --- run folder ----------------------------------------------------------------------------------

def proof_home() -> Path:
    return repo_root() / ".proof"


def exclude_proof() -> None:
    """.proof/ stays out of commits: git's own exclude file, shared by every worktree."""
    common = Path(sh(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.strip())
    ex = common / "info" / "exclude"
    ex.parent.mkdir(parents=True, exist_ok=True)
    text = ex.read_text() if ex.exists() else ""
    if ".proof/" not in text.split():
        ex.write_text(text + ("" if text.endswith("\n") or not text else "\n") + ".proof/\n")


def latest_run(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).resolve()
    runs = sorted(p for p in proof_home().glob("*") if p.is_dir())
    if not runs:
        sys.exit("babysit-proof: no run folder yet: run `proof.py init` first")
    return runs[-1]


def cmd_init(_a) -> None:
    exclude_proof()
    run = proof_home() / dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    (run / "steps").mkdir(parents=True)
    print(run)


def cmd_fixture(a) -> None:
    dest = Path(a.dir).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy(HERE / "proof.fixture.ts", dest / "proof.fixture.ts")
    print(dest / "proof.fixture.ts")


def record_result(run: Path, kind: str, code: int, extra: dict) -> None:
    f = run / "results.json"
    data = json.loads(f.read_text()) if f.exists() else []
    data.append({"kind": kind, "exit": code, "at": dt.datetime.now().isoformat(timespec="seconds"), **extra})
    f.write_text(json.dumps(data, indent=2))


def tee(cmd: list[str], log: Path, env: dict, cwd: Path) -> int:
    """Run, showing output live and keeping a copy."""
    with open(log, "w") as out:
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in p.stdout:  # type: ignore[union-attr]
            sys.stdout.write(line)
            out.write(line)
        return p.wait()


# --- web: Playwright -----------------------------------------------------------------------------

def cmd_web(a) -> None:
    run = latest_run(a.run)
    root = repo_root()
    if not list(root.rglob("proof.fixture.ts")):
        sys.exit("babysit-proof: no proof.fixture.ts in this repo: run `proof.py fixture <e2e dir>` and import "
                 "`test`/`expect` from it in the specs that cover this feature")
    env = {**os.environ, "PROOF_DIR": str(run), "PLAYWRIGHT_JSON_OUTPUT_NAME": str(run / "playwright.json")}
    # Playwright's own output (traces, failure screenshots) goes in the run folder too.
    out = [] if any(x.startswith("--output") for x in a.args) else ["--output", str(run / "playwright-output")]
    code = tee(["npx", "playwright", "test", "--reporter=list,json", *out, *a.args], run / "tests-web.log", env, root)
    stats = {}
    try:
        stats = json.loads((run / "playwright.json").read_text()).get("stats", {})
    except (OSError, ValueError):
        pass
    record_result(run, "playwright", code, {"stats": {k: stats.get(k) for k in ("expected", "unexpected", "flaky", "skipped")}})
    print(f"\nbabysit-proof: {count_images(run)} screenshots in {run / 'steps'}; playwright exit {code}")
    sys.exit(code)


# --- Expo: Maestro -------------------------------------------------------------------------------

def maestro_bin() -> str:
    for c in (shutil.which("maestro"), str(HOME / ".maestro" / "bin" / "maestro")):
        if c and Path(c).exists():
            v = subprocess.run([c, "--version"], text=True, capture_output=True)
            if "Java 17" in (v.stdout + v.stderr):
                sys.exit("babysit-proof: Maestro needs Java 17 or newer: `brew install openjdk@17` (then follow brew's "
                         "note to link it), and try again")
            return c
    sys.exit("babysit-proof: maestro not found: `curl -Ls https://get.maestro.mobile.dev | bash`")


class Recorder:
    """The simulator's screen, recorded while the flow runs (iOS simulator or Android device)."""

    def __init__(self, platform: str, out: Path):
        self.platform, self.out, self.proc = platform, out, None
        self.segments: list[Path] = []
        self.stop_flag = False

    def start(self) -> float:
        if self.platform == "ios":
            self.proc = subprocess.Popen(["xcrun", "simctl", "io", "booted", "recordVideo", "--codec=h264", "--force", str(self.out)],
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            # simctl prints "Recording started" once frames flow.
            t0 = time.time()
            while time.time() - t0 < 10 and self.proc.stdout:
                line = self.proc.stdout.readline()
                if "Recording started" in line or not line:
                    break
            return time.time()
        # Android: screenrecord stops at 3 minutes; keep recording in segments until stopped.
        self.proc = subprocess.Popen(["bash", "-c", 'i=0; while [ ! -f "$1" ]; do adb shell screenrecord --time-limit 170 /sdcard/proof-$i.mp4; i=$((i+1)); done; echo $i', "_", str(self.out) + ".stop"],
                                     stdout=subprocess.PIPE, text=True)
        time.sleep(1.0)
        return time.time() - 1.0

    def stop(self) -> None:
        if not self.proc:
            return
        if self.platform == "ios":
            self.proc.send_signal(signal.SIGINT)
            self.proc.wait(timeout=30)
            return
        Path(str(self.out) + ".stop").touch()
        subprocess.run(["adb", "shell", "pkill", "-INT", "screenrecord"], capture_output=True)
        n = int((self.proc.communicate(timeout=60)[0] or "1").strip().splitlines()[-1] or 1)
        parts = []
        for i in range(n):
            seg = self.out.with_name(f"seg-{i}.mp4")
            if subprocess.run(["adb", "pull", f"/sdcard/proof-{i}.mp4", str(seg)], capture_output=True).returncode == 0:
                parts.append(seg)
            subprocess.run(["adb", "shell", "rm", "-f", f"/sdcard/proof-{i}.mp4"], capture_output=True)
        lst = self.out.with_name("segments.txt")
        lst.write_text("".join(f"file '{p}'\n" for p in parts))
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(self.out)], capture_output=True)
        Path(str(self.out) + ".stop").unlink(missing_ok=True)


SKIP = {"defineVariablesCommand", "applyConfigurationCommand", "runFlowCommand", "runScriptCommand", "evalScriptCommand"}


def describe(kind: str, body: dict) -> str:
    """A short step name from a Maestro command."""
    verb = re.sub(r"Command$", "", kind)
    verb = re.sub(r"(?<!^)([A-Z])", r" \1", verb).lower()
    sel = body.get("selector") or {}
    target = (sel.get("textRegex") or sel.get("idRegex") or body.get("text") or body.get("link") or body.get("appId")
              or (body.get("selector") and json.dumps(sel)[:40]) or "")
    return f"{verb} {target}".strip()


def steps_from_debug(debug: Path) -> list[dict]:
    out = []
    for f in sorted(debug.glob("commands-*.json")):
        flow = re.sub(r"^commands-\(?|\)?\.json$", "", f.name)
        for e in json.loads(f.read_text()):
            c = e.get("command") or {}
            kind = next(iter(c), "")
            if not kind or kind in SKIP:
                continue
            m = e.get("metadata") or {}
            ts, dur = m.get("timestamp"), m.get("duration") or 0
            if not isinstance(ts, (int, float)):
                continue
            out.append({"flow": flow, "seq": m.get("sequenceNumber", 0), "status": m.get("status", "?"),
                        "label": describe(kind, c[kind] if isinstance(c[kind], dict) else {}), "end_ms": ts + dur})
    out.sort(key=lambda s: (s["flow"], s["seq"]))
    return out


def cut_frames(video: Path, video_start: float, steps: list[dict], dest: Path, settle: float = 0.4) -> int:
    """One frame per step, just after it finished (settle: let the screen redraw)."""
    dur = float(sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)]).stdout.strip() or 0)
    n = 0
    per_flow: dict[str, int] = {}
    for s in steps:
        at = min(max(0.0, s["end_ms"] / 1000 - video_start + settle), max(0.0, dur - 0.05))
        i = per_flow[s["flow"]] = per_flow.get(s["flow"], 0) + 1
        d = dest / slug(s["flow"], 80)
        d.mkdir(parents=True, exist_ok=True)
        name = f"{i:02d}-{'FAILED-' if s['status'] == 'FAILED' else ''}{slug(s['label'])}.png"
        if subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{at:.3f}", "-i", str(video), "-frames:v", "1", str(d / name)], capture_output=True).returncode == 0:
            n += 1
    return n


def cmd_expo(a) -> None:
    run = latest_run(a.run)
    mae = maestro_bin()
    if not shutil.which("ffmpeg"):
        sys.exit("babysit-proof: ffmpeg is needed to cut the step screenshots: `brew install ffmpeg`")
    debug = run / "maestro-debug"
    video = run / "screen.mp4"
    rec = Recorder(a.platform, video)
    start = rec.start()
    code = 1
    try:
        code = tee([mae, "test", a.flow, "--no-ansi", "--debug-output", str(debug), "--flatten-debug-output"], run / "tests-expo.log", dict(os.environ), Path.cwd())
    finally:
        rec.stop()
    steps = steps_from_debug(debug)
    n = cut_frames(video, start, steps, run / "steps") if video.exists() and steps else 0
    failed = sum(1 for s in steps if s["status"] == "FAILED")
    record_result(run, "maestro", code, {"steps": len(steps), "failed_steps": failed, "platform": a.platform})
    print(f"\nbabysit-proof: {n} screenshots from {len(steps)} steps in {run / 'steps'}; maestro exit {code}")
    sys.exit(code)


# --- changes and publishing ------------------------------------------------------------------------

def base_ref() -> str:
    head = sh(["git", "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], check=False).stdout.strip()
    return head or "origin/main"


def linked_issue() -> tuple[int | None, str, list[str]]:
    """The session's issue and PRs, from babysit-ticket."""
    if not TT.exists():
        return None, "", []
    out = sh(["bash", str(TT), "show"], check=False).stdout
    m = re.match(r"#(\d+) (.*)", out.strip())
    prs = re.findall(r"^pr: (\S+)$", out, re.M)
    return (int(m.group(1)), m.group(2), prs) if m else (None, "", prs)


def cmd_changes(a) -> None:
    run = latest_run(a.run)
    base = base_ref()
    mb = sh(["git", "merge-base", "HEAD", base], check=False).stdout.strip() or base
    branch = sh(["git", "branch", "--show-current"], check=False).stdout.strip() or "(detached)"
    commits = sh(["git", "log", "--no-merges", "--format=- %s (%h)", f"{mb}..HEAD"], check=False).stdout.strip()
    stat = sh(["git", "diff", "--stat", mb], check=False).stdout.strip()
    dirty = sh(["git", "status", "--porcelain"], check=False).stdout.strip()
    n, title, prs = linked_issue()
    lines = [f"**Branch** `{branch}` against `{base.replace('refs/remotes/', '')}`", ""]
    if prs:
        lines += ["**PRs**", *[f"- {p}" for p in prs], ""]
    lines += ["**Commits**", commits or "- (none yet)", "", "<details><summary>Files changed</summary>", "", "```", stat or "(no changes)", "```", "</details>"]
    if dirty:
        lines += ["", f"_{len(dirty.splitlines())} uncommitted file(s) at the time of this run._"]
    (run / "changes.md").write_text("\n".join(lines) + "\n")
    print(run / "changes.md")
    if n:
        print(f"linked issue: #{n} {title}")


def count_images(run: Path) -> int:
    return sum(1 for _ in (run / "steps").rglob("*.png")) if (run / "steps").exists() else 0


def origin_slug() -> str:
    url = sh(["git", "remote", "get-url", "origin"]).stdout.strip()
    m = re.search(r"github\.com[^:/]*[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", url)
    if not m:
        sys.exit(f"babysit-proof: origin is not a GitHub repository: {url}")
    return f"{m.group(1)}/{m.group(2)}"


def push_images(run: Path, images: list[Path], issue: int | None) -> tuple[str, str]:
    """Commit the images to the babysit-proof branch of origin without touching the work tree or
    the checked-out branch (a private index), push it, and return (commit, folder)."""
    folder = f"{issue or 'no-issue'}/{run.name}"
    have = sh(["git", "ls-remote", "origin", f"refs/heads/{BRANCH}"], check=False).stdout.split()
    parent = None
    if have:
        sh(["git", "fetch", "--quiet", "origin", f"refs/heads/{BRANCH}"])
        parent = sh(["git", "rev-parse", "FETCH_HEAD"]).stdout.strip()
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(tmp) / "index")}
        if parent:
            sh(["git", "read-tree", parent], env=env)
        for img in images:
            blob = sh(["git", "hash-object", "-w", str(img)]).stdout.strip()
            rel = f"{folder}/{img.relative_to(run / 'steps').as_posix()}"
            sh(["git", "update-index", "--add", "--cacheinfo", f"100644,{blob},{rel}"], env=env)
        tree = sh(["git", "write-tree"], env=env).stdout.strip()
    commit = sh(["git", "commit-tree", tree, *(["-p", parent] if parent else []), "-m", f"babysit-proof screenshots for {folder}"]).stdout.strip()
    sh(["git", "push", "--quiet", "origin", f"{commit}:refs/heads/{BRANCH}"])
    return commit, folder


def results_md(run: Path) -> str:
    f = run / "results.json"
    if not f.exists():
        return "_No test run recorded._"
    out = []
    for r in json.loads(f.read_text()):
        ok = "✅" if r["exit"] == 0 else "❌"
        if r["kind"] == "playwright":
            s = r.get("stats") or {}
            out.append(f"{ok} Playwright: {s.get('expected') or 0} passed, {s.get('unexpected') or 0} failed, {s.get('flaky') or 0} flaky, {s.get('skipped') or 0} skipped")
        else:
            out.append(f"{ok} Maestro ({r.get('platform')}): {r.get('steps', 0)} steps, {r.get('failed_steps', 0)} failed")
    return "\n".join(f"- {x}" for x in out)


def cmd_publish(a) -> None:
    run = latest_run(a.run)
    n, _title, _prs = linked_issue()
    issue = a.issue or n
    summary = (run / "summary.md").read_text().strip() if (run / "summary.md").exists() else ""
    if not summary:
        sys.exit(f"babysit-proof: write the feature summary to {run / 'summary.md'} first")
    changes = (run / "changes.md").read_text().strip() if (run / "changes.md").exists() else ""
    images = sorted((run / "steps").rglob("*.png"))
    slug_ = origin_slug()
    shown = images[:MAX_IMAGES]
    if a.dry_run:
        commit, folder = "DRY-RUN", f"{issue or 'no-issue'}/{run.name}"
    else:
        commit, folder = push_images(run, shown, issue) if shown else ("", "")
    parts = ["## 🧪 babysit-proof", "", summary, "", "### Tests", results_md(run), ""]
    if changes:
        parts += ["### What changed", changes, ""]
    if shown:
        parts += ["### Screenshots"]
        group = None
        for img in shown:
            rel = img.relative_to(run / "steps").as_posix()
            g = rel.rsplit("/", 1)[0] if "/" in rel else ""
            if g != group:
                group = g
                parts += ["", f"**{g.replace('-', ' ')}**" if g else "", ""]
            step = re.sub(r"^\d+-", "", img.stem).replace("-", " ").strip()
            url = f"https://github.com/{slug_}/blob/{commit}/{folder}/{rel}?raw=true"
            parts += [f"<details open><summary>{img.stem[:2]}. {step}</summary>", "", f"![{step}]({url})", "", "</details>"]
        if len(images) > len(shown):
            parts += ["", f"_{len(images) - len(shown)} more screenshots are in the run folder `{run.name}`._"]
    body = "\n".join(parts) + "\n"
    (run / "comment.md").write_text(body)
    if a.dry_run or not issue:
        print(body)
        print(f"babysit-proof: {'dry run' if a.dry_run else 'no linked issue (link the session with babysit-ticket, or pass --issue N)'}: "
              f"nothing posted; the comment is in {run / 'comment.md'}")
        return
    owner = sh([str(MASTER), "config", "get", "owner"], check=False).stdout.strip()
    repo = sh([str(MASTER), "config", "get", "issueRepo"], check=False).stdout.strip()
    if not owner or not repo:
        sys.exit("babysit-proof: no issue repository configured (MasterDeck Setup, or `master config save`)")
    r = sh(["gh", "issue", "comment", str(issue), "-R", f"{owner}/{repo}", "--body-file", str(run / "comment.md")])
    print(r.stdout.strip())


def main() -> None:
    ap = argparse.ArgumentParser(prog="proof.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", help="run folder (default: the newest under .proof/)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init").set_defaults(fn=cmd_init)
    f = sub.add_parser("fixture")
    f.add_argument("dir")
    f.set_defaults(fn=cmd_fixture)
    w = sub.add_parser("web")
    w.add_argument("args", nargs=argparse.REMAINDER)
    w.set_defaults(fn=cmd_web)
    e = sub.add_parser("expo")
    e.add_argument("flow")
    e.add_argument("--platform", choices=["ios", "android"], default="ios")
    e.set_defaults(fn=cmd_expo)
    sub.add_parser("changes").set_defaults(fn=cmd_changes)
    p = sub.add_parser("publish")
    p.add_argument("--issue", type=int)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_publish)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
