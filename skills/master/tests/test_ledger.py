# tests/test_ledger.py
from __future__ import annotations

import json
import multiprocessing
import os
import tempfile
import unittest
from pathlib import Path

from master import ledger

NOW = "2026-09-24T10:00:00Z"
LATER = "2026-09-24T11:00:00Z"


def add(led, **overrides):
    kw = dict(kind="REVIEW", issue=939, source="s1", target={"session": "paywall"},
              message="#939: address threads", summary="address threads", now=NOW)
    kw.update(overrides)
    return ledger.add(led, **kw)


def _adder(home, prefix):
    # Runs in a child process: 50 locked read-modify-writes.
    os.environ["MASTER_HOME"] = home
    for i in range(50):
        with ledger.locked() as led:
            add(led, source=f"{prefix}{i}")


class LedgerTest(unittest.TestCase):
    def test_load_missing_file_returns_empty_ledger(self):
        with tempfile.TemporaryDirectory() as d:
            led = ledger.load(Path(d) / "ledger.json")
        self.assertEqual(led["proposals"], [])
        self.assertEqual(led["next_id"], 1)
        self.assertIsNone(led["last_snapshot"])
        self.assertEqual(led["cursor"], {"snapshot_at": None, "meetings_since": None})

    def test_save_then_load_round_trips(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "sub" / "ledger.json"
            led = ledger.empty()
            add(led)
            ledger.save(led, path)
            self.assertEqual(ledger.load(path), led)

    def test_ledger_path_honours_master_home(self):
        with tempfile.TemporaryDirectory() as d:
            old = os.environ.get("MASTER_HOME")
            os.environ["MASTER_HOME"] = d
            try:
                self.assertEqual(ledger.ledger_path(), Path(d) / "ledger.json")
            finally:
                if old is None:
                    del os.environ["MASTER_HOME"]
                else:
                    os.environ["MASTER_HOME"] = old

    def test_add_assigns_increasing_ids_and_proposed_status(self):
        led = ledger.empty()
        a = add(led, source="a")
        b = add(led, source="b")
        self.assertEqual((a["id"], b["id"]), (1, 2))
        self.assertEqual(a["status"], "proposed")
        self.assertEqual(a["created_at"], NOW)
        self.assertEqual(led["next_id"], 3)

    def test_same_key_is_duplicate_even_after_reject(self):
        led = ledger.empty()
        p = add(led)
        ledger.transition(led, p["id"], "rejected", now=LATER)
        self.assertIsNone(add(led))
        self.assertIsNotNone(add(led, source="s2"))
        self.assertIsNotNone(add(led, kind="CI"))

    def test_transition_sets_timestamps(self):
        led = ledger.empty()
        p = add(led)
        ledger.transition(led, p["id"], "approved", now=NOW)
        self.assertEqual(p["decided_at"], NOW)
        ledger.transition(led, p["id"], "sent", now=LATER, note="bg 1234")
        self.assertEqual((p["sent_at"], p["note"]), (LATER, "bg 1234"))
        ledger.transition(led, p["id"], "done", now=LATER)
        self.assertEqual((p["status"], p["closed_at"]), ("done", LATER))

    def test_illegal_transition_raises(self):
        led = ledger.empty()
        p = add(led)
        with self.assertRaises(ValueError):
            ledger.transition(led, p["id"], "sent", now=NOW)

    def test_held_and_blocked_can_be_resent(self):
        led = ledger.empty()
        p = add(led)
        for to in ("approved", "sent", "held", "sent", "blocked", "sent", "done"):
            ledger.transition(led, p["id"], to, now=NOW)
        self.assertEqual(p["status"], "done")

    def test_question_transitions_table(self):
        self.assertEqual(ledger.TRANSITIONS["question"], {"sent", "done", "blocked", "rejected", "question"})
        self.assertIn("question", ledger.TRANSITIONS["sent"])

    def test_sent_question_sent_round_trip_sets_no_extra_timestamps(self):
        led = ledger.empty()
        p = add(led)
        ledger.transition(led, p["id"], "approved", now=NOW)
        ledger.transition(led, p["id"], "sent", now=NOW)
        ledger.transition(led, p["id"], "question", now=LATER, note="which approach?")
        self.assertEqual(p["status"], "question")
        self.assertEqual(p["note"], "which approach?")
        self.assertIsNone(p["closed_at"])
        self.assertEqual(p["sent_at"], NOW)
        ledger.transition(led, p["id"], "sent", now=LATER)
        self.assertEqual((p["status"], p["sent_at"]), ("sent", LATER))

    def test_second_question_replaces_the_note(self):
        led = ledger.empty()
        p = add(led)
        for to in ("approved", "sent"):
            ledger.transition(led, p["id"], to, now=NOW)
        ledger.transition(led, p["id"], "question", now=NOW, note="first?")
        ledger.transition(led, p["id"], "question", now=LATER, note="second?")
        self.assertEqual((p["status"], p["note"], p["sent_at"], p["closed_at"]), ("question", "second?", NOW, None))

    def test_question_can_go_to_done(self):
        led = ledger.empty()
        p = add(led)
        for to in ("approved", "sent", "question", "done"):
            ledger.transition(led, p["id"], to, now=NOW)
        self.assertEqual((p["status"], p["closed_at"]), ("done", NOW))

    def test_proposed_to_question_is_illegal(self):
        led = ledger.empty()
        p = add(led)
        with self.assertRaises(ValueError):
            ledger.transition(led, p["id"], "question", now=NOW)

    def test_done_question_sent_done_round_trip_clears_and_resets_closed_at(self):
        led = ledger.empty()
        p = add(led)
        for to in ("approved", "sent", "done"):
            ledger.transition(led, p["id"], to, now=NOW)
        self.assertEqual((p["status"], p["closed_at"]), ("done", NOW))
        ledger.transition(led, p["id"], "question", now=LATER, note="one more thing?")
        self.assertEqual((p["status"], p["closed_at"], p["note"]), ("question", None, "one more thing?"))
        ledger.transition(led, p["id"], "sent", now=LATER)
        self.assertEqual((p["status"], p["closed_at"], p["sent_at"]), ("sent", None, LATER))
        ledger.transition(led, p["id"], "done", now=LATER)
        self.assertEqual((p["status"], p["closed_at"]), ("done", LATER))

    def test_done_to_sent_directly_is_legal_and_clears_closed_at(self):
        led = ledger.empty()
        p = add(led)
        for to in ("approved", "sent", "done"):
            ledger.transition(led, p["id"], to, now=NOW)
        ledger.transition(led, p["id"], "sent", now=LATER)
        self.assertEqual((p["status"], p["closed_at"], p["sent_at"]), ("sent", None, LATER))

    def test_rejected_to_anything_is_still_illegal(self):
        led = ledger.empty()
        p = add(led)
        ledger.transition(led, p["id"], "rejected", now=NOW)
        for to in ("sent", "done", "blocked", "held", "question", "approved", "rejected"):
            with self.assertRaises(ValueError):
                ledger.transition(led, p["id"], to, now=LATER)

    def test_get_unknown_raises_keyerror(self):
        with self.assertRaises(KeyError):
            ledger.get(ledger.empty(), 99)

    def test_set_note_keeps_status(self):
        led = ledger.empty()
        p = add(led)
        ledger.transition(led, p["id"], "approved", now=NOW)
        ledger.set_note(led, p["id"], "spawn failed: boom")
        self.assertEqual((p["status"], p["note"]), ("approved", "spawn failed: boom"))

    def test_load_adds_acked_to_old_ledgers(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "ledger.json"
            old = ledger.empty()
            del old["acked"]
            path.write_text(json.dumps(old))
            self.assertEqual(ledger.load(path)["acked"], [])

    def test_locked_saves_on_exit(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "ledger.json"
            with ledger.locked(path) as led:
                add(led)
            self.assertEqual(len(ledger.load(path)["proposals"]), 1)
            self.assertTrue((Path(d) / "ledger.lock").exists())

    def test_locked_does_not_save_when_block_raises(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "ledger.json"
            with self.assertRaises(RuntimeError):
                with ledger.locked(path) as led:
                    add(led)
                    raise RuntimeError("boom")
            self.assertFalse(path.exists())

    def test_concurrent_writers_lose_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = multiprocessing.get_context("spawn")
            procs = [ctx.Process(target=_adder, args=(d, prefix)) for prefix in ("a", "b")]
            for proc in procs:
                proc.start()
            for proc in procs:
                proc.join(60)
            self.assertEqual([proc.exitcode for proc in procs], [0, 0])
            led = ledger.load(Path(d) / "ledger.json")
            self.assertEqual(sorted(p["id"] for p in led["proposals"]), list(range(1, 101)))


if __name__ == "__main__":
    unittest.main()
