// Generates cover.png (800x534) for gladys-caiso: plain Node, no dependency.
// A sun over hills, a transmission tower and its lines, a price curve that
// dips below zero at midday, a leaf for the renewables, on a dusk gradient
// (no logo of the ISO). Drawing helpers taken from gladys-attente-frontiere
// (same author).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.4 + (y / H) * 0.6;
  return [70 + 150 * t, 90 + 40 * t, 170 - 60 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

disc(400, 270, 260, white, 0.05);
const sun = [255, 205, 90];
const hill = [46, 70, 110];
const steel = [220, 228, 240];
const leaf = [110, 215, 140];
const curve = [255, 140, 90];

// The sun, low over the hills.
disc(170, 150, 70, sun, 0.95);
for (let k = 0; k < 12; k += 1) {
  const a = (k * Math.PI) / 6;
  line(
    170 + 88 * Math.cos(a),
    150 + 88 * Math.sin(a),
    170 + 112 * Math.cos(a),
    150 + 112 * Math.sin(a),
    8,
    sun,
  );
}

// Hills along the bottom.
for (let x = 0; x < W; x += 1) {
  const top = Math.round(420 - 40 * Math.sin(x / 130) - 20 * Math.sin(x / 47));
  for (let y = top; y < H; y += 1) set(x, y, hill);
}

// A transmission tower and its lines.
const tower = (cx, base, h) => {
  line(cx - 40, base, cx - 8, base - h, 7, steel);
  line(cx + 40, base, cx + 8, base - h, 7, steel);
  for (let k = 1; k < 5; k += 1) {
    const y = base - (h * k) / 5;
    const half = 40 - (32 * k) / 5;
    line(cx - half, y, cx + half, y, 4, steel);
    line(cx - half, y, cx + half - 6, y - h / 5, 3, steel);
  }
  line(cx - 60, base - h + 30, cx + 60, base - h + 30, 6, steel);
  line(cx - 45, base - h + 60, cx + 45, base - h + 60, 6, steel);
};
tower(610, 430, 260);
for (const dy of [30, 60]) {
  line(0, 230 + dy * 0.6, 550, 170 + dy + 30 - 30, 2, steel);
  line(670, 170 + dy, 800, 200 + dy, 2, steel);
}

// A price curve: high in the morning, below zero at midday, high at dusk.
box(285, 225, 535, 350, 16, white, 0.12);
const axisY = 330;
line(300, axisY, 520, axisY, 3, white);
let px0;
let py0;
for (let i = 0; i <= 44; i += 1) {
  const x = 300 + i * 5;
  const t = i / 44;
  const y = axisY - 60 * Math.cos(2 * Math.PI * t) - 20;
  if (px0 !== undefined) line(px0, py0, x, y, 6, curve);
  px0 = x;
  py0 = y;
}

// A leaf: the renewables share.
disc(720, 90, 34, leaf);
disc(700, 70, 30, leaf);
line(680, 125, 735, 70, 5, [40, 110, 70]);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
