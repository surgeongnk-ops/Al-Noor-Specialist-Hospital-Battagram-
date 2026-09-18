"""Parser engine: deterministic ASTM/HL7/delimited regex parsing first,
falling back to a Claude tool-use call when the payload does not match any
known analyzer protocol or yields no usable records.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import List, Optional

from .config import AnthropicSettings
from .db import ParsedResult

logger = logging.getLogger("lims.parser")

STX = "\x02"
ETX = "\x03"
EOT = "\x04"


class ParserError(Exception):
    """Raised when no parser -- deterministic or Claude fallback -- could
    extract any usable result from a payload."""


@dataclass
class ParseOutcome:
    results: List[ParsedResult]
    protocol: str  # 'ASTM' | 'HL7' | 'DELIMITED' | 'CLAUDE_FALLBACK'
    source: str    # 'deterministic' | 'claude_fallback'


# ---------------------------------------------------------------------------
# ASTM E1394
# ---------------------------------------------------------------------------

_ASTM_FRAME_CHARS = re.compile(f"[{STX}{ETX}{EOT}]")
_ASTM_CHECKSUM_TAIL = re.compile(r"[0-9A-Fa-f]{2}\r?\n?$")


def _split_astm_records(text: str) -> List[str]:
    cleaned = _ASTM_FRAME_CHARS.sub("", text)
    # Drop a leading frame-number digit pyserial/analyzers prepend (e.g. "1H|...")
    cleaned = re.sub(r"^\d(?=[A-Z]\|)", "", cleaned)
    records = re.split(r"[\r\n]+", cleaned)
    return [r for r in (rec.strip() for rec in records) if r]


def _first_nonempty(fields: List[str]) -> Optional[str]:
    for f in fields:
        if f and f.strip():
            return f.strip()
    return None


def _extract_last_component(field: str) -> Optional[str]:
    """Last non-empty ^-component, e.g. ASTM universal test id '^^^^GLU' -> 'GLU'."""
    parts = [p for p in field.split("^") if p.strip()]
    return parts[-1].strip() if parts else (field.strip() or None)


def _extract_first_component(field: str) -> Optional[str]:
    """First non-empty ^-component, e.g. HL7 'PID-88422^^^MRN' -> 'PID-88422'."""
    parts = [p for p in field.split("^") if p.strip()]
    return parts[0].strip() if parts else (field.strip() or None)


def _extract_hl7_test_name(field: str) -> Optional[str]:
    """HL7 CWE-style identifier 'code^text^codingSystem' -> prefer the text
    component; fall back to the code when text is absent."""
    parts = [p.strip() for p in field.split("^") if p.strip()]
    if not parts:
        return None
    return parts[1] if len(parts) >= 2 else parts[0]


_ASTM_FLAG_MAP = {
    "H": "HIGH", "L": "LOW", "N": "NORMAL", "A": "ABNORMAL",
    "HH": "PANIC_HIGH", "LL": "PANIC_LOW", "": "UNKNOWN",
}


def looks_like_astm(text: str) -> bool:
    for line in _split_astm_records(text):
        if re.match(r"^[HPOLQMC]\|", line):
            return True
    return False


def parse_astm(text: str) -> List[ParsedResult]:
    if not looks_like_astm(text):
        return []

    results: List[ParsedResult] = []
    current_patient: Optional[str] = None
    current_sample: Optional[str] = None

    for record in _split_astm_records(text):
        fields = record.split("|")
        rtype = fields[0][:1].upper() if fields and fields[0] else ""

        if rtype == "P":
            current_patient = _first_nonempty(fields[2:6])
        elif rtype == "O":
            current_sample = _first_nonempty(fields[2:3]) or _first_nonempty(fields[1:2])
        elif rtype == "R":
            test_name = _extract_last_component(fields[2]) if len(fields) > 2 else None
            value = fields[3].strip() if len(fields) > 3 and fields[3].strip() else None
            if not test_name or not value:
                continue
            unit = fields[4].strip() if len(fields) > 4 and fields[4].strip() else None
            ref_range = fields[5].strip() if len(fields) > 5 and fields[5].strip() else None
            raw_flag = fields[6].strip().upper() if len(fields) > 6 else ""
            results.append(ParsedResult(
                test_name=test_name,
                value=value,
                patient_id=current_patient,
                sample_id=current_sample,
                unit=unit,
                reference_range=ref_range,
                flag=_ASTM_FLAG_MAP.get(raw_flag, "UNKNOWN"),
                instrument="ASTM",
            ))
    return results


# ---------------------------------------------------------------------------
# HL7 v2.x
# ---------------------------------------------------------------------------

_HL7_OBX_VALUE_INDEX = 5


def looks_like_hl7(text: str) -> bool:
    for line in re.split(r"[\r\n]+", text):
        if re.match(r"^(MSH|PID|OBR|OBX)\|", line.strip()):
            return True
    return False


def parse_hl7(text: str) -> List[ParsedResult]:
    if not looks_like_hl7(text):
        return []

    results: List[ParsedResult] = []
    current_patient: Optional[str] = None
    current_sample: Optional[str] = None

    for segment in re.split(r"[\r\n]+", text):
        segment = segment.strip()
        if not segment:
            continue
        fields = segment.split("|")
        seg_id = fields[0].upper()

        if seg_id == "PID":
            raw_pid = fields[3] if len(fields) > 3 else ""
            current_patient = _extract_first_component(raw_pid) if raw_pid else None
        elif seg_id == "OBR":
            raw_order = fields[3] if len(fields) > 3 and fields[3].strip() else (fields[2] if len(fields) > 2 else "")
            current_sample = _extract_first_component(raw_order) if raw_order else None
        elif seg_id == "OBX":
            if len(fields) <= _HL7_OBX_VALUE_INDEX:
                continue
            test_name = _extract_hl7_test_name(fields[3]) if len(fields) > 3 else None
            value = fields[5].strip() if len(fields) > 5 and fields[5].strip() else None
            if not test_name or not value:
                continue
            unit = fields[6].strip() if len(fields) > 6 and fields[6].strip() else None
            ref_range = fields[7].strip() if len(fields) > 7 and fields[7].strip() else None
            raw_flag = fields[8].strip().upper() if len(fields) > 8 else ""
            results.append(ParsedResult(
                test_name=test_name,
                value=value,
                patient_id=current_patient,
                sample_id=current_sample,
                unit=unit,
                reference_range=ref_range,
                flag=_ASTM_FLAG_MAP.get(raw_flag, "UNKNOWN"),
                instrument="HL7",
            ))
    return results


# ---------------------------------------------------------------------------
# Custom delimited text (header row + CSV/TSV data rows)
# ---------------------------------------------------------------------------

_DELIMITED_REQUIRED_COLUMNS = {"TEST", "VALUE"}
_DELIMITED_ALIASES = {
    "PATIENT_ID": ("PATIENT_ID", "PATIENT", "PID"),
    "SAMPLE_ID": ("SAMPLE_ID", "SAMPLE", "SID", "SPECIMEN_ID"),
    "UNIT": ("UNIT", "UNITS"),
    "REFERENCE_RANGE": ("REFERENCE_RANGE", "REF_RANGE", "RANGE"),
    "FLAG": ("FLAG",),
}


def parse_delimited(text: str) -> List[ParsedResult]:
    lines = [ln.strip() for ln in re.split(r"[\r\n]+", text) if ln.strip()]
    if len(lines) < 2:
        return []

    delimiter = "\t" if "\t" in lines[0] else ","
    header = [h.strip().upper() for h in lines[0].split(delimiter)]
    if not _DELIMITED_REQUIRED_COLUMNS.issubset(set(header)):
        return []

    col_index = {name: idx for idx, name in enumerate(header)}

    def resolve(canonical: str, fields: List[str]) -> Optional[str]:
        for alias in _DELIMITED_ALIASES.get(canonical, (canonical,)):
            idx = col_index.get(alias)
            if idx is not None and idx < len(fields) and fields[idx].strip():
                return fields[idx].strip()
        return None

    results: List[ParsedResult] = []
    for line in lines[1:]:
        fields = [f.strip() for f in line.split(delimiter)]
        test_name = fields[col_index["TEST"]].strip() if col_index["TEST"] < len(fields) else ""
        value = fields[col_index["VALUE"]].strip() if col_index["VALUE"] < len(fields) else ""
        if not test_name or not value:
            continue
        results.append(ParsedResult(
            test_name=test_name,
            value=value,
            patient_id=resolve("PATIENT_ID", fields),
            sample_id=resolve("SAMPLE_ID", fields),
            unit=resolve("UNIT", fields),
            reference_range=resolve("REFERENCE_RANGE", fields),
            flag=(resolve("FLAG", fields) or "UNKNOWN").upper(),
            instrument="DELIMITED",
        ))
    return results


# ---------------------------------------------------------------------------
# Claude API fallback (tool use / function calling)
# ---------------------------------------------------------------------------

FALLBACK_TOOL = {
    "name": "record_lab_results",
    "description": (
        "Record every discrete lab analyte result found in a raw, "
        "non-standardized analyzer message."
    ),
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "patient_id": {"type": ["string", "null"]},
                        "sample_id": {"type": ["string", "null"]},
                        "test_name": {"type": "string"},
                        "value": {"type": "string"},
                        "unit": {"type": ["string", "null"]},
                        "reference_range": {"type": ["string", "null"]},
                        "flag": {
                            "type": "string",
                            "enum": ["HIGH", "LOW", "NORMAL", "ABNORMAL", "PANIC_HIGH", "PANIC_LOW", "UNKNOWN"],
                        },
                    },
                    "required": ["patient_id", "sample_id", "test_name", "value", "unit", "reference_range", "flag"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["results"],
        "additionalProperties": False,
    },
}

_FALLBACK_SYSTEM_PROMPT = (
    "You are a clinical laboratory interface engine. You will be given a raw "
    "text payload captured verbatim from a hematology or biochemistry "
    "analyzer's serial port that could not be parsed as standard ASTM E1394, "
    "HL7 v2.x, or delimited text. Extract every discrete analyte result you "
    "can find and call record_lab_results exactly once with the complete "
    "list. Use null for any field that is genuinely absent from the source "
    "text -- never invent a patient id, sample id, unit, or reference range. "
    "Report numeric values as strings exactly as they appear; do not round "
    "or convert units."
)


def claude_fallback_parse(raw_text: str, settings: AnthropicSettings) -> List[ParsedResult]:
    if not settings.is_configured:
        raise ParserError("Claude fallback required but ANTHROPIC_API_KEY is not configured")

    import anthropic  # imported lazily so the module loads without the SDK installed

    client = anthropic.Anthropic(api_key=settings.api_key)

    try:
        response = client.messages.create(
            model=settings.model,
            max_tokens=settings.max_tokens,
            system=_FALLBACK_SYSTEM_PROMPT,
            tools=[FALLBACK_TOOL],
            tool_choice={"type": "tool", "name": "record_lab_results"},
            messages=[{"role": "user", "content": raw_text}],
        )
    except anthropic.RateLimitError as exc:
        raise ParserError(f"Claude fallback rate-limited: {exc}") from exc
    except anthropic.APIStatusError as exc:
        raise ParserError(f"Claude fallback request rejected ({exc.status_code}): {exc.message}") from exc
    except anthropic.APIConnectionError as exc:
        raise ParserError(f"Claude fallback network error: {exc}") from exc

    tool_block = next((b for b in response.content if b.type == "tool_use"), None)
    if tool_block is None:
        raise ParserError("Claude fallback returned no tool_use block")

    raw_results = tool_block.input.get("results") or []
    results: List[ParsedResult] = []
    for item in raw_results:
        test_name = (item.get("test_name") or "").strip()
        value = (item.get("value") or "").strip()
        if not test_name or not value:
            continue
        results.append(ParsedResult(
            test_name=test_name,
            value=value,
            patient_id=(item.get("patient_id") or None),
            sample_id=(item.get("sample_id") or None),
            unit=(item.get("unit") or None),
            reference_range=(item.get("reference_range") or None),
            flag=(item.get("flag") or "UNKNOWN").upper(),
            instrument="CLAUDE_FALLBACK",
        ))

    if not results:
        raise ParserError("Claude fallback extracted zero usable results")
    return results


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

_DETERMINISTIC_PARSERS = (
    ("ASTM", parse_astm),
    ("HL7", parse_hl7),
    ("DELIMITED", parse_delimited),
)


def parse(raw_payload: bytes, anthropic_settings: AnthropicSettings) -> ParseOutcome:
    """Parse a raw serial payload into structured lab results.

    Tries each deterministic parser in order; the first one that both
    recognizes the payload's shape and yields at least one result wins. If
    none do, falls back to the Claude tool-use extractor. Raises
    ParserError if every strategy fails.
    """
    text = raw_payload.decode("utf-8", errors="replace")

    for protocol, parser_fn in _DETERMINISTIC_PARSERS:
        try:
            results = parser_fn(text)
        except Exception:
            logger.exception("Deterministic %s parser crashed; trying next strategy", protocol)
            continue
        if results:
            logger.debug("Parsed %d result(s) via deterministic %s parser", len(results), protocol)
            return ParseOutcome(results=results, protocol=protocol, source="deterministic")

    logger.info("No deterministic parser matched; invoking Claude fallback")
    results = claude_fallback_parse(text, anthropic_settings)
    return ParseOutcome(results=results, protocol="CLAUDE_FALLBACK", source="claude_fallback")
