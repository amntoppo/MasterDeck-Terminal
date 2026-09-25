from __future__ import annotations

import unittest

from master import guard


def _fail(*_a, **_kw):
    raise AssertionError("agents_loader must not be called")


class GuardTest(unittest.TestCase):
    def test_plain_terminal_allowed_without_calling_loader(self):
        self.assertIsNone(guard.check({}, _fail))

    def test_no_claudecode_is_allowed(self):
        self.assertIsNone(guard.check({"CLAUDECODE": "0"}, _fail))

    def test_matching_session_allowed(self):
        env = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "abc"}
        loader = lambda: [{"name": "master-agent", "sessionId": "abc"}, {"name": "other", "sessionId": "xyz"}]
        self.assertIsNone(guard.check(env, loader))

    def test_mismatching_session_refused(self):
        env = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "xyz"}
        loader = lambda: [{"name": "master-agent", "sessionId": "abc"}]
        self.assertEqual(guard.check(env, loader), guard.REFUSAL)

    def test_loader_raising_is_refused(self):
        env = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "abc"}

        def boom():
            raise RuntimeError("claude not found")

        self.assertEqual(guard.check(env, boom), guard.REFUSAL)

    def test_no_master_row_is_refused(self):
        env = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "abc"}
        loader = lambda: [{"name": "someone-else", "sessionId": "abc"}]
        self.assertEqual(guard.check(env, loader), guard.REFUSAL)

    def test_missing_session_id_is_refused(self):
        env = {"CLAUDECODE": "1"}
        loader = lambda: [{"name": "master-agent", "sessionId": "abc"}]
        self.assertEqual(guard.check(env, loader), guard.REFUSAL)

    def test_ambiguous_master_rows_refused(self):
        env = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "abc"}
        loader = lambda: [{"name": "master-agent", "sessionId": "abc"},
                          {"name": "master-agent", "sessionId": "def"}]
        self.assertEqual(guard.check(env, loader), guard.REFUSAL)

    def test_loader_returning_dict_is_refused(self):
        env = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "abc"}
        loader = lambda: {"name": "master-agent", "sessionId": "abc"}
        self.assertEqual(guard.check(env, loader), guard.REFUSAL)

    def test_loader_returning_none_is_refused(self):
        env = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "abc"}
        loader = lambda: None
        self.assertEqual(guard.check(env, loader), guard.REFUSAL)

    def test_loader_returning_list_of_strings_is_refused(self):
        env = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "abc"}
        loader = lambda: ["master-agent", "other"]
        self.assertEqual(guard.check(env, loader), guard.REFUSAL)


if __name__ == "__main__":
    unittest.main()
