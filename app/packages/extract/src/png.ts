// A PNG from raw pixels (what pdf.js decodes a scan's image to), with node's zlib: no image library.
import { crc32, deflateSync } from "node:zlib";

const COLOR = { 1: 0, 3: 2, 4: 6 } as const; // grey, RGB, RGBA

function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function png(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: 1 | 3 | 4) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, COLOR[channels], 0, 0, 0], 8); // 8 bits a sample, no interlace
  const row = width * channels;
  const raw = Buffer.alloc((row + 1) * height); // each row starts with filter type 0 (none)
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array()),
  ]);
}
