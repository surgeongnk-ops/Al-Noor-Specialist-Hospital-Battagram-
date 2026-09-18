"""PySerial receiver daemon.

Buffers a hematology/biochemistry analyzer's serial stream until a full
message frame has arrived, then hands the raw frame off to a callback for
logging and parsing. Runs its own thread so the caller's event loop (or
the CLI's main thread) is never blocked on the port.

Framing strategy:
  - ENQ (0x05) from the analyzer is ACKed (0x06) immediately -- the
    standard ASTM E1394 / LIS02-A2 handshake opener.
  - A frame is considered complete when an ETX (0x03) or EOT (0x04)
    control byte is seen, or when a read times out with unflushed bytes
    already buffered (covers plain CRLF/line-based instruments that never
    send an explicit terminator).
  - Each ETX-terminated frame is ACKed back to the analyzer, and the
    trailing checksum + CRLF that LIS02-A2 appends after ETX is discarded
    before the next frame starts accumulating.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable, Optional

from .config import ACK, ENQ, ETX, EOT, SerialSettings

logger = logging.getLogger("lims.listener")

FrameCallback = Callable[[bytes], None]

# Bytes to discard after ETX: two checksum hex digits + CR + LF.
_ASTM_FRAME_TAIL_LENGTH = 4


class SerialListener:
    """Threaded, non-blocking reader for one serial (COM) port."""

    def __init__(self, settings: SerialSettings, on_frame: FrameCallback, read_chunk_size: int = 1024) -> None:
        self.settings = settings
        self.on_frame = on_frame
        self.read_chunk_size = read_chunk_size
        self._serial = None
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def start(self) -> None:
        import serial  # pyserial; imported lazily so --mock needs no hardware deps

        self._serial = serial.Serial(
            port=self.settings.port,
            baudrate=self.settings.baud_rate,
            bytesize=self.settings.bytesize,
            parity=self.settings.parity,
            stopbits=self.settings.stopbits,
            timeout=self.settings.read_timeout,
        )
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="serial-listener", daemon=True)
        self._thread.start()
        logger.info(
            "Serial listener started on %s @ %d baud (%d%s%s)",
            self.settings.port, self.settings.baud_rate,
            self.settings.bytesize, self.settings.parity, self.settings.stopbits,
        )

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        if self._serial is not None:
            self._serial.close()
        logger.info("Serial listener stopped")

    def _run(self) -> None:
        buffer = bytearray()
        skip_remaining = 0

        while not self._stop_event.is_set():
            try:
                chunk = self._serial.read(self.read_chunk_size)
            except Exception:
                logger.exception("Serial read failed on %s; stopping listener", self.settings.port)
                break

            if not chunk:
                # Read timed out with no new bytes: treat any unterminated,
                # unflushed buffer as a complete message (line-based instruments).
                if buffer:
                    self._emit(bytes(buffer))
                    buffer.clear()
                continue

            for byte in chunk:
                if skip_remaining > 0:
                    skip_remaining -= 1
                    continue

                if byte == ENQ:
                    self._write_control(ACK)
                    continue

                buffer.append(byte)

                if byte in (ETX, EOT):
                    self._emit(bytes(buffer))
                    buffer.clear()
                    if byte == ETX:
                        self._write_control(ACK)
                        skip_remaining = _ASTM_FRAME_TAIL_LENGTH

    def _emit(self, frame: bytes) -> None:
        if not frame.strip():
            return
        try:
            self.on_frame(frame)
        except Exception:
            logger.exception("on_frame callback raised for frame: %r", frame[:200])

    def _write_control(self, byte: int) -> None:
        try:
            self._serial.write(bytes([byte]))
        except Exception:
            logger.exception("Failed to write control byte 0x%02X to %s", byte, self.settings.port)
