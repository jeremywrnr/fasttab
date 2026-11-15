// Tiny PNG encoder for the toolbar icon: a rounded square with three
// staggered "tab" bars. Avoids checking binary assets into the repo.
import { deflateSync } from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function icon(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.22;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const bars = [
    [0.2, 0.24, 0.62],
    [0.2, 0.44, 0.8],
    [0.2, 0.64, 0.5],
  ];
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const fx = (x + 0.5) / size;
      const fy = (y + 0.5) / size;
      let c = [0, 0, 0, 0];
      if (inRounded(x + 0.5, y + 0.5)) {
        c = [26, 115, 232, 255];
        for (const [x0, y0, x1] of bars) if (fx >= x0 && fx <= x1 && fy >= y0 && fy <= y0 + 0.12) c = [255, 255, 255, 255];
      }
      px.set(c, o);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(px)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makeIcons() {
  return [16, 32, 48, 128].map((s) => [s, icon(s)]);
}
