"""Minimal varint-prefixed protobuf I/O — the on-disk format chakra ET files
use. Adapted from chakra/src/third_party/utils/protolib.py to avoid pulling
the full chakra Python tree into the wheel."""
from __future__ import annotations

import struct
from typing import IO


def _encode_varint32(out_file: IO[bytes], value: int) -> None:
    bits = value & 0x7F
    value >>= 7
    while value:
        out_file.write(struct.pack("<B", 0x80 | bits))
        bits = value & 0x7F
        value >>= 7
    out_file.write(struct.pack("<B", bits))


def encode_message(out_file: IO[bytes], message) -> None:
    """Length-prepend with a 32-bit varint then write the serialized body —
    the format chakra's C++ reader expects."""
    payload = message.SerializeToString()
    _encode_varint32(out_file, len(payload))
    out_file.write(payload)


def _decode_varint32(in_file: IO[bytes]) -> int:
    """Read a varint back; raises EOFError on clean end-of-stream so callers
    can stop iterating."""
    value = 0
    shift = 0
    while True:
        byte = in_file.read(1)
        if not byte:
            raise EOFError
        b = struct.unpack("<B", byte)[0]
        value |= (b & 0x7F) << shift
        if not (b & 0x80):
            return value
        shift += 7


def decode_message(in_file: IO[bytes], message) -> bool:
    """Read one length-delimited message into `message`. Returns False at
    clean EOF, True after a successful read."""
    try:
        length = _decode_varint32(in_file)
    except EOFError:
        return False
    body = in_file.read(length)
    if len(body) != length:
        raise EOFError(f"truncated message: expected {length}, got {len(body)}")
    message.ParseFromString(body)
    return True
