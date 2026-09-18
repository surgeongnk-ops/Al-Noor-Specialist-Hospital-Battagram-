"""Unified CLI entry point for the Al Noor Specialist Hospital serial LIMS
integration daemon.

Usage:
    python -m lims_daemon.main --port /dev/ttyUSB0 --baud 9600
    python -m lims_daemon.main --mock
    python -m lims_daemon.main --mock --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import threading
from typing import Optional

from .config import Config, SerialSettings, AnthropicSettings, DEFAULT_ANTHROPIC_MODEL
from .db import Database, compute_flag
from .listener import SerialListener
from .parser import ParserError, parse

logger = logging.getLogger("lims.main")

# ---------------------------------------------------------------------------
# Mock analyzer frames -- exercise all three deterministic protocols plus a
# garbled payload that forces the Claude fallback path.
# ---------------------------------------------------------------------------

MOCK_FRAMES = [
    # ASTM E1394: normal glucose + a critically high potassium (panic value).
    (
        "H|\\^&|||AlNoorAnalyzer^1.0|||||||P|1|20260115120000\r"
        "P|1||PID-88421||Khan^Ahmed||19800101|M\r"
        "O|1|SID-55231||^^^^Glucose|R|20260115120500\r"
        "R|1|^^^^Glucose|5.6|mmol/L|3.9-6.1|N||F||\r"
        "R|2|^^^^Potassium|7.5|mmol/L|3.5-5.1|H||F||\r"
        "L|1|N\r"
    ).encode("ascii"),

    # HL7 v2.x ORU^R01: a critically low WBC (panic value) + normal hemoglobin.
    (
        "MSH|^~\\&|LIS|LAB|HIS|ALNOOR|20260115121500||ORU^R01|MSG00002|P|2.3\r"
        "PID|1||PID-88422^^^MRN||Bibi^Sana||19900505|F\r"
        "OBR|1|ORD-1002|SID-55232|CBC^Complete Blood Count\r"
        "OBX|1|NM|WBC^WBC||0.5|10^3/uL|4.0-11.0|LL||F\r"
        "OBX|2|NM|HGB^Hemoglobin||13.2|g/dL|12.0-16.0|N||F\r"
    ).encode("ascii"),

    # Custom delimited text, as some low-cost chemistry analyzers emit.
    (
        "PATIENT_ID,SAMPLE_ID,TEST,VALUE,UNIT,REF_RANGE,FLAG\r\n"
        "PID-88423,SID-55233,Creatinine,1.1,mg/dL,0.6-1.3,N\r\n"
        "PID-88423,SID-55233,Sodium,138,mmol/L,135-145,N\r\n"
    ).encode("ascii"),

    # Non-standard / vendor-proprietary dump: no ASTM, HL7, or delimited
    # structure matches, so this must fall back to the Claude parser.
    (
        b"** BC-500 AUTO HEMATOLOGY ANALYZER **\n"
        b"Pt: Rahim, Zubair   Spec#: 55234-B\n"
        b"-- RESULTS --\n"
        b"Hemoglobin .... 6.2 g/dL  (ref 12-16)  *LOW*\n"
        b"Platelets ..... 410 10^3/uL (ref 150-450)\n"
        b"END OF REPORT\n"
    ),
]


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lims-daemon",
        description="Serial LIMS integration daemon for hematology/biochemistry analyzers.",
    )
    parser.add_argument("--port", default="/dev/ttyUSB0", help="Serial port, e.g. COM1 or /dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=9600, help="Baud rate (default: 9600)")
    parser.add_argument("--bytesize", type=int, default=8, choices=(5, 6, 7, 8))
    parser.add_argument("--parity", default="N", choices=("N", "E", "O", "M", "S"))
    parser.add_argument("--stopbits", type=int, default=1, choices=(1, 2))
    parser.add_argument("--timeout", type=float, default=1.0, help="Read timeout in seconds (default: 1.0)")
    parser.add_argument("--db-path", default="al_noor_clinical.db", help="SQLite database file")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Parse frames and print results to stdout without writing to the database",
    )
    parser.add_argument(
        "--mock", action="store_true",
        help="Inject built-in sample ASTM/HL7/delimited/non-standard frames instead of opening a real port",
    )
    parser.add_argument("--anthropic-model", default=DEFAULT_ANTHROPIC_MODEL, help="Claude model for fallback parsing")
    parser.add_argument("--no-fallback", action="store_true", help="Disable the Claude API fallback parser")
    parser.add_argument("--log-level", default="INFO", choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    parser.add_argument("--log-file", default=None, help="Optional path to also log to a file")
    return parser


def config_from_args(args: argparse.Namespace) -> Config:
    return Config(
        db_path=args.db_path,
        serial=SerialSettings(
            port=args.port,
            baud_rate=args.baud,
            bytesize=args.bytesize,
            parity=args.parity,
            stopbits=args.stopbits,
            read_timeout=args.timeout,
        ),
        anthropic=AnthropicSettings(model=args.anthropic_model, enabled=not args.no_fallback),
        dry_run=args.dry_run,
        log_level=args.log_level,
        log_file=args.log_file,
    )


def setup_logging(cfg: Config) -> None:
    handlers = [logging.StreamHandler(sys.stdout)]
    if cfg.log_file:
        handlers.append(logging.FileHandler(cfg.log_file))
    logging.basicConfig(
        level=getattr(logging, cfg.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        handlers=handlers,
        force=True,
    )


def process_frame(raw_frame: bytes, cfg: Config, db: Optional[Database]) -> None:
    """Shared pipeline for both the live serial listener and --mock mode.

    Write order: raw payload -> serial_logs, THEN parse, THEN clean rows ->
    lab_results + serial_logs.processed update. In --dry-run mode nothing
    touches the database; parsed output is printed instead.
    """
    log_id: Optional[int] = None
    if not cfg.dry_run and db is not None:
        log_id = db.insert_serial_log(cfg.serial.port, cfg.serial.baud_rate, raw_frame)

    try:
        outcome = parse(raw_frame, cfg.anthropic)
    except ParserError as exc:
        logger.error("Failed to parse frame (%d bytes): %s", len(raw_frame), exc)
        if log_id is not None and db is not None:
            db.mark_processed(log_id, parse_source=None, error=str(exc))
        return

    logger.info(
        "Parsed %d result(s) via %s (%s)", len(outcome.results), outcome.protocol, outcome.source,
    )

    if cfg.dry_run or db is None:
        for result in outcome.results:
            flag, is_panic = compute_flag(result.test_name, result.value, result.reference_range, result.flag)
            print(json.dumps({
                "patient_id": result.patient_id,
                "sample_id": result.sample_id,
                "test_name": result.test_name,
                "value": result.value,
                "unit": result.unit,
                "reference_range": result.reference_range,
                "flag": flag,
                "is_panic": is_panic,
                "instrument": result.instrument,
                "parse_source": outcome.source,
            }))
        return

    db.mark_processed(log_id, parse_source=outcome.source)
    for result in outcome.results:
        db.insert_lab_result(log_id, result, outcome.source)


def run_mock(cfg: Config, db: Optional[Database]) -> None:
    logger.info("Running in --mock mode: injecting %d sample frame(s)", len(MOCK_FRAMES))
    for frame in MOCK_FRAMES:
        process_frame(frame, cfg, db)


def run_live(cfg: Config, db: Optional[Database]) -> None:
    stop_event = threading.Event()

    def on_frame(raw_frame: bytes) -> None:
        process_frame(raw_frame, cfg, db)

    listener = SerialListener(cfg.serial, on_frame=on_frame)
    listener.start()

    def handle_signal(signum, frame) -> None:
        logger.info("Received signal %s, shutting down", signum)
        stop_event.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        # threading.Event.wait() (unlike signal.pause()) works on Windows too,
        # which matters here since COM ports are a first-class target.
        while not stop_event.is_set():
            stop_event.wait(timeout=1.0)
    finally:
        listener.stop()


def main(argv: Optional[list] = None) -> int:
    args = build_arg_parser().parse_args(argv)
    cfg = config_from_args(args)
    setup_logging(cfg)

    if not cfg.anthropic.is_configured:
        logger.warning(
            "ANTHROPIC_API_KEY not set (or fallback disabled) -- non-standard payloads that "
            "fail deterministic parsing will be logged as errors instead of Claude-parsed."
        )

    db = None if cfg.dry_run else Database(cfg.db_path)
    try:
        if args.mock:
            run_mock(cfg, db)
        else:
            run_live(cfg, db)
    finally:
        if db is not None:
            db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
