-- Al Noor Specialist Hospital -- Serial LIMS Integration Daemon
-- SQLite schema: al_noor_clinical.db
--
-- serial_logs holds every raw payload exactly as it arrived off the wire,
-- written BEFORE any parsing is attempted, so a parser bug or crash never
-- loses an analyzer result. lab_results holds the clean, structured rows
-- derived from a serial_logs entry once parsing succeeds.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS serial_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    port            TEXT NOT NULL,
    baud_rate       INTEGER NOT NULL,
    protocol_guess  TEXT,                       -- 'ASTM' | 'HL7' | 'DELIMITED' | 'UNKNOWN'
    raw_payload     BLOB NOT NULL,
    received_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    processed       INTEGER NOT NULL DEFAULT 0,  -- 0 = pending/failed, 1 = parsed successfully
    parse_source    TEXT,                        -- 'deterministic' | 'claude_fallback'
    parse_error     TEXT
);

CREATE INDEX IF NOT EXISTS idx_serial_logs_processed   ON serial_logs(processed);
CREATE INDEX IF NOT EXISTS idx_serial_logs_received_at ON serial_logs(received_at);

CREATE TABLE IF NOT EXISTS lab_results (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_log_id    INTEGER NOT NULL REFERENCES serial_logs(id) ON DELETE CASCADE,
    patient_id       TEXT,
    sample_id        TEXT,
    test_name        TEXT NOT NULL,
    value            TEXT NOT NULL,
    unit             TEXT,
    reference_range  TEXT,
    flag             TEXT NOT NULL DEFAULT 'UNKNOWN'
                     CHECK (flag IN ('HIGH','LOW','NORMAL','ABNORMAL','PANIC_HIGH','PANIC_LOW','UNKNOWN')),
    is_panic         INTEGER NOT NULL DEFAULT 0,
    parse_source     TEXT NOT NULL DEFAULT 'deterministic'
                     CHECK (parse_source IN ('deterministic','claude_fallback')),
    instrument       TEXT,
    resulted_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_lab_results_sample_id  ON lab_results(sample_id);
CREATE INDEX IF NOT EXISTS idx_lab_results_patient_id ON lab_results(patient_id);
CREATE INDEX IF NOT EXISTS idx_lab_results_is_panic   ON lab_results(is_panic);
CREATE INDEX IF NOT EXISTS idx_lab_results_serial_log ON lab_results(serial_log_id);
