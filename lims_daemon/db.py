"""SQLite persistence layer for the serial LIMS daemon.

Write order is always: raw payload -> serial_logs (transaction A), then
parse, then clean rows -> lab_results + serial_logs.processed update
(transaction B). A parser crash between the two transactions leaves the
raw payload safely on disk in serial_logs for later re-processing.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

from . import config as cfg

logger = logging.getLogger("lims.db")

_SCHEMA_PATH = Path(__file__).parent / "schema.sql"

_RANGE_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*$")


@dataclass
class ParsedResult:
    """A single normalized analyte result ready for insertion."""

    test_name: str
    value: str
    patient_id: Optional[str] = None
    sample_id: Optional[str] = None
    unit: Optional[str] = None
    reference_range: Optional[str] = None
    flag: str = "UNKNOWN"
    instrument: Optional[str] = None


def compute_flag(test_name: str, value: str, reference_range: Optional[str], existing_flag: Optional[str]) -> tuple[str, bool]:
    """Derive (flag, is_panic) for a result.

    Panic thresholds (config.PANIC_THRESHOLDS) always take priority over the
    reference range on the message, since a critical value must never be
    silently masked by a stale or mistyped instrument range.
    """
    try:
        numeric_value = float(value)
    except (TypeError, ValueError):
        return (existing_flag or "UNKNOWN"), False

    key = test_name.strip().lower()
    panic = cfg.PANIC_THRESHOLDS.get(key)
    if panic is not None:
        low, high, _unit = panic
        if numeric_value < low:
            return "PANIC_LOW", True
        if numeric_value > high:
            return "PANIC_HIGH", True

    if reference_range:
        match = _RANGE_RE.match(reference_range)
        if match:
            low, high = float(match.group(1)), float(match.group(2))
            if numeric_value < low:
                return "LOW", False
            if numeric_value > high:
                return "HIGH", False
            return "NORMAL", False

    return (existing_flag or "UNKNOWN"), False


class Database:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._init_schema()

    def _init_schema(self) -> None:
        with self._conn:
            self._conn.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))
        logger.debug("Schema ensured at %s", self.db_path)

    @contextmanager
    def _cursor(self) -> Iterator[sqlite3.Cursor]:
        cur = self._conn.cursor()
        try:
            yield cur
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        finally:
            cur.close()

    def insert_serial_log(self, port: str, baud_rate: int, raw_payload: bytes, protocol_guess: Optional[str] = None) -> int:
        with self._cursor() as cur:
            cur.execute(
                """
                INSERT INTO serial_logs (port, baud_rate, protocol_guess, raw_payload)
                VALUES (?, ?, ?, ?)
                """,
                (port, baud_rate, protocol_guess, raw_payload),
            )
            log_id = cur.lastrowid
        logger.info("serial_logs#%s recorded (%d bytes, port=%s)", log_id, len(raw_payload), port)
        return log_id

    def mark_processed(self, serial_log_id: int, parse_source: Optional[str], error: Optional[str] = None) -> None:
        with self._cursor() as cur:
            cur.execute(
                """
                UPDATE serial_logs
                SET processed = ?, parse_source = ?, parse_error = ?
                WHERE id = ?
                """,
                (0 if error else 1, parse_source, error, serial_log_id),
            )

    def insert_lab_result(self, serial_log_id: int, result: ParsedResult, parse_source: str) -> int:
        flag, is_panic = compute_flag(result.test_name, result.value, result.reference_range, result.flag)
        with self._cursor() as cur:
            cur.execute(
                """
                INSERT INTO lab_results (
                    serial_log_id, patient_id, sample_id, test_name, value,
                    unit, reference_range, flag, is_panic, parse_source, instrument
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    serial_log_id,
                    result.patient_id,
                    result.sample_id,
                    result.test_name,
                    result.value,
                    result.unit,
                    result.reference_range,
                    flag,
                    int(is_panic),
                    parse_source,
                    result.instrument,
                ),
            )
            result_id = cur.lastrowid
        if is_panic:
            logger.warning(
                "PANIC VALUE: %s=%s%s (sample=%s, patient=%s)",
                result.test_name, result.value, result.unit or "", result.sample_id, result.patient_id,
            )
        return result_id

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()
