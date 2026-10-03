import json
import tempfile
import unittest
from pathlib import Path

from master.collect import links_state


class LinksState(unittest.TestCase):
    def test_reads_masterdeck_links_only(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "ticket-links.json").write_text(json.dumps({"importedAt": 1, "sessions": {"a": {"issue": 1}}, "branches": {"x@f": 1}}))
            self.assertEqual(links_state(Path(d)), {"sessions": {"a": {"issue": 1}}, "branches": {"x@f": 1}})

    def test_missing_or_broken_file_is_empty(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(links_state(Path(d)), {"sessions": {}, "branches": {}})
            Path(d, "ticket-links.json").write_text("{oops")
            self.assertEqual(links_state(Path(d)), {"sessions": {}, "branches": {}})

    def test_non_dict_json_is_empty(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "ticket-links.json").write_text("[1]")
            self.assertEqual(links_state(Path(d)), {"sessions": {}, "branches": {}})
