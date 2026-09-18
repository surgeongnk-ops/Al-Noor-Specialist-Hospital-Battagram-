"""End-to-end unit test: mock analyzer frames -> parser -> SQLite, with the
Claude API fallback call stubbed out so the suite needs neither a network
connection nor an ANTHROPIC_API_KEY.

Run with:  python -m unittest lims_daemon.test_mock -v
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from . import main as lims_main
from .config import Config
from .db import Database, ParsedResult


def _fallback_stub(raw_text: str, settings) -> list:
    """Stand-in for parser.claude_fallback_parse: returns what Claude would
    plausibly extract from the mock's non-standard BC-500 hematology dump,
    without making a real API call."""
    return [
        ParsedResult(
            test_name="Hemoglobin",
            value="6.2",
            unit="g/dL",
            reference_range="12-16",
            flag="LOW",
            sample_id="55234-B",
            patient_id="Rahim, Zubair",
            instrument="CLAUDE_FALLBACK",
        ),
    ]


class MockIngestionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp_dir, "test_al_noor_clinical.db")

    def _query(self, sql: str, params: tuple = ()):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    def test_mock_frames_end_to_end(self) -> None:
        cfg = Config(db_path=self.db_path, dry_run=False)
        cfg.anthropic.enabled = False  # deterministic parsers must handle 3/4 frames unaided

        db = Database(self.db_path)
        try:
            with patch("lims_daemon.parser.claude_fallback_parse", side_effect=_fallback_stub):
                lims_main.run_mock(cfg, db)
        finally:
            db.close()

        logs = self._query("SELECT * FROM serial_logs ORDER BY id")
        self.assertEqual(len(logs), len(lims_main.MOCK_FRAMES))
        self.assertTrue(all(row["processed"] == 1 for row in logs), "every mock frame should parse cleanly")

        results = self._query("SELECT * FROM lab_results ORDER BY id")
        self.assertEqual(len(results), 7)  # 2 ASTM + 2 HL7 + 2 delimited + 1 Claude fallback

        # ASTM frame: Potassium 7.5 mmol/L breaches the configured critical
        # band (2.5-6.5) -> must be flagged as a panic value.
        potassium = self._query("SELECT * FROM lab_results WHERE test_name = 'Potassium'")[0]
        self.assertEqual(potassium["parse_source"], "deterministic")
        self.assertEqual(potassium["flag"], "PANIC_HIGH")
        self.assertEqual(potassium["is_panic"], 1)

        # HL7 frame: WBC 0.5 breaches the critical band (1.0-30.0) -> panic low.
        wbc = self._query("SELECT * FROM lab_results WHERE test_name = 'WBC'")[0]
        self.assertEqual(wbc["flag"], "PANIC_LOW")
        self.assertEqual(wbc["is_panic"], 1)

        # Delimited frame: Creatinine sits inside its own reference range -> normal.
        creatinine = self._query("SELECT * FROM lab_results WHERE test_name = 'Creatinine'")[0]
        self.assertEqual(creatinine["parse_source"], "deterministic")
        self.assertEqual(creatinine["flag"], "NORMAL")
        self.assertEqual(creatinine["is_panic"], 0)

        # Non-standard vendor dump: none of the deterministic parsers should
        # match it, so it must have gone through the (stubbed) Claude fallback.
        fallback_rows = self._query("SELECT * FROM lab_results WHERE parse_source = 'claude_fallback'")
        self.assertEqual(len(fallback_rows), 1)
        self.assertEqual(fallback_rows[0]["test_name"], "Hemoglobin")
        self.assertEqual(fallback_rows[0]["flag"], "LOW")
        self.assertEqual(fallback_rows[0]["sample_id"], "55234-B")

    def test_dry_run_writes_nothing_to_the_database(self) -> None:
        # Touch the file once so schema exists, then verify --dry-run never inserts.
        Database(self.db_path).close()

        cfg = Config(db_path=self.db_path, dry_run=True)
        cfg.anthropic.enabled = False

        with patch("lims_daemon.parser.claude_fallback_parse", side_effect=_fallback_stub):
            lims_main.run_mock(cfg, None)

        logs = self._query("SELECT COUNT(*) AS n FROM serial_logs")
        self.assertEqual(logs[0]["n"], 0)


if __name__ == "__main__":
    unittest.main()
