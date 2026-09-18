# serial-bridge.ps1 — reads a Windows COM port and streams the raw bytes to
# stdout, byte-for-byte, so analyzers/microlabBridge.js (running in the
# parent Node process) can parse them.
#
# Why this exists: Node has no built-in serial port API, and this whole
# system deliberately has zero npm dependencies (single hospital PC,
# unreliable internet — installing a native serial-port package is not an
# option here). Every Windows PC already ships PowerShell with the .NET
# System.IO.Ports.SerialPort class built in, so this script does the actual
# port I/O and the Node side just spawns it as a child process — no extra
# install, ever.
#
# Usage (invoked by microlabBridge.js, not normally run by hand):
#   powershell -NoProfile -ExecutionPolicy Bypass -File serial-bridge.ps1 `
#     -PortName COM3 -BaudRate 9600 -Parity None -DataBits 8 -StopBits One

param(
  [string]$PortName = "COM3",
  [int]$BaudRate = 9600,
  [string]$Parity = "None",
  [int]$DataBits = 8,
  [string]$StopBits = "One"
)

$ErrorActionPreference = "Stop"

try {
  $parityEnum = [System.IO.Ports.Parity]::$Parity
  $stopBitsEnum = [System.IO.Ports.StopBits]::$StopBits
  $port = New-Object System.IO.Ports.SerialPort($PortName, $BaudRate, $parityEnum, $DataBits, $stopBitsEnum)
  $port.ReadTimeout = 500
  $port.Open()
} catch {
  [Console]::Error.WriteLine("SERIAL_OPEN_FAILED: $($_.Exception.Message)")
  exit 1
}

[Console]::Error.WriteLine("SERIAL_OPEN_OK: listening on $PortName @ $BaudRate baud")

# Write raw bytes straight to the process's standard output stream — NOT
# [Console]::WriteLine, which would apply text encoding/newline translation
# and corrupt binary control bytes (ENQ, STX, etc.) an ASTM-speaking device
# might send. This keeps the byte stream exactly as received.
$stdout = [Console]::OpenStandardOutput()
$buffer = New-Object byte[] 4096

while ($true) {
  try {
    $n = $port.Read($buffer, 0, $buffer.Length)
    if ($n -gt 0) {
      $stdout.Write($buffer, 0, $n)
      $stdout.Flush()
    }
  } catch [System.TimeoutException] {
    # No data within the read timeout — normal idle state, keep listening.
    continue
  } catch {
    [Console]::Error.WriteLine("SERIAL_READ_ERROR: $($_.Exception.Message)")
    Start-Sleep -Milliseconds 500
  }
}
