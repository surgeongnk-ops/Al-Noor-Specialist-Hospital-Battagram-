"""Offline Serial LIMS Integration Daemon for Al Noor Specialist Hospital.

Bridges hematology/biochemistry analyzers over serial (COM) ports to a
local SQLite database, with a Claude API fallback for non-standardized
analyzer output that deterministic ASTM/HL7/delimited parsing can't handle.
"""
