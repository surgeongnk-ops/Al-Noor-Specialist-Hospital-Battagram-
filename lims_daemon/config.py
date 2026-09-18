"""Configuration for the Al Noor Specialist Hospital serial LIMS daemon.

Settings are resolved with CLI arguments taking precedence over environment
variables, which take precedence over the defaults below.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

# Frame-boundary control characters used to detect where one analyzer
# message ends and the next begins on the wire.
ENQ = 0x05
ACK = 0x06
NAK = 0x15
STX = 0x02
ETX = 0x03
EOT = 0x04
CR = 0x0D
LF = 0x0A

DEFAULT_DB_PATH = "al_noor_clinical.db"
DEFAULT_BAUD_RATE = 9600
DEFAULT_BYTESIZE = 8
DEFAULT_PARITY = "N"
DEFAULT_STOPBITS = 1
DEFAULT_READ_TIMEOUT_SECONDS = 1.0

DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5"

# (critical_low, critical_high, expected_unit) keyed by lower-cased, whitespace-
# stripped test name. Any result outside this band is flagged as a panic value
# regardless of what the reference range on the message says. This is a
# starter table for common hematology/biochemistry analytes -- extend per the
# lab's own critical-value policy.
PANIC_THRESHOLDS: Dict[str, Tuple[float, float, str]] = {
    "glucose": (2.2, 22.2, "mmol/L"),
    "potassium": (2.5, 6.5, "mmol/L"),
    "sodium": (120.0, 160.0, "mmol/L"),
    "hemoglobin": (5.0, 20.0, "g/dL"),
    "wbc": (1.0, 30.0, "10^3/uL"),
    "platelets": (20.0, 1000.0, "10^3/uL"),
    "creatinine": (0.1, 10.0, "mg/dL"),
}


@dataclass
class SerialSettings:
    port: str = "/dev/ttyUSB0"
    baud_rate: int = DEFAULT_BAUD_RATE
    bytesize: int = DEFAULT_BYTESIZE
    parity: str = DEFAULT_PARITY
    stopbits: int = DEFAULT_STOPBITS
    read_timeout: float = DEFAULT_READ_TIMEOUT_SECONDS


@dataclass
class AnthropicSettings:
    api_key: Optional[str] = field(default_factory=lambda: os.environ.get("ANTHROPIC_API_KEY"))
    model: str = field(default_factory=lambda: os.environ.get("ANTHROPIC_MODEL", DEFAULT_ANTHROPIC_MODEL))
    max_tokens: int = 2048
    enabled: bool = True

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key) and self.enabled


@dataclass
class Config:
    db_path: str = field(default_factory=lambda: os.environ.get("LIMS_DB_PATH", DEFAULT_DB_PATH))
    serial: SerialSettings = field(default_factory=SerialSettings)
    anthropic: AnthropicSettings = field(default_factory=AnthropicSettings)
    dry_run: bool = False
    log_level: str = field(default_factory=lambda: os.environ.get("LIMS_LOG_LEVEL", "INFO"))
    log_file: Optional[str] = field(default_factory=lambda: os.environ.get("LIMS_LOG_FILE"))
