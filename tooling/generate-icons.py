"""Regenerate the manifest PNG icons with only Python's standard library.

The book silhouette corresponds to public/icons/reader.svg. Four samples per
pixel keep edges smooth; no font, external asset, or imaging dependency exists.
"""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1] / "public" / "icons"
BACKGROUND = (20, 102, 91)
PAPER = (255, 253, 242)
INK = (156, 186, 177)


def color_at(x, y):
    # All meaningful artwork is within the maskable icon's central safe zone.
    if 132 <= x <= 248:
        t = (x - 132) / 116
        top = (1 - t) ** 2 * 158 + 2 * (1 - t) * t * 142 + t * t * 178
        bottom = (1 - t) ** 2 * 336 + 2 * (1 - t) * t * 320 + t * t * 354
        if top <= y <= bottom:
            if 160 <= x <= 220:
                t = (x - 160) / 60
                line = 191 + 13 * t * t
                if abs(y - line) < 5 or abs(y - line - 34) < 5:
                    return INK
            return PAPER
    if 264 <= x <= 380:
        return color_at(512 - x, y)
    return BACKGROUND


def chunk(kind, data):
    payload = kind + data
    return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload))


def render(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            colors = [color_at((x + dx) * 512 / size, (y + dy) * 512 / size)
                      for dx in (0.25, 0.75) for dy in (0.25, 0.75)]
            rows.extend(round(sum(c[channel] for c in colors) / 4) for channel in range(3))
    image = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
             + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))
    (ROOT / f"reader-{size}.png").write_bytes(image)


if __name__ == "__main__":
    for size in (192, 512):
        render(size)
