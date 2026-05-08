// Generates simple monochrome template PNG icons for the menubar tray.
// Template images use only black + alpha; macOS auto-inverts for the menu bar.
// We hand-roll the PNG so we don't pull in `sharp` or `canvas`.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// width/height in px. pixels is a (w*h) array of {a:0..255}; color is always black.
function encodePng(width, height, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 4;   // colour type: grayscale + alpha
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // raw scanlines: filter byte 0 + (gray, alpha) per pixel; gray=0 (black)
  const rowBytes = 1 + width * 2;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * rowBytes + 1 + x * 2;
      raw[i] = 0; // gray = black
      raw[i + 1] = pixels[y * width + x] | 0; // alpha
    }
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Glyph: a rounded square outline with a small downward arrow inside.
// Suggests "drop a link in here". Symmetric, reads at 16px.
function drawIdle(size) {
  const px = new Uint8Array(size * size); // alpha buffer
  const stroke = Math.max(1, Math.round(size / 16));
  const margin = Math.round(size * 0.125); // 2px at 16
  const a = margin;
  const b = size - margin - 1;

  // outer rounded-ish square (just a square; rounding eyeballs the same at 16px)
  for (let i = a; i <= b; i++) {
    for (let s = 0; s < stroke; s++) {
      px[a + s] && 0; // no-op to satisfy linter? actually skip
      px[(a + s) * size + i] = 255;       // top
      px[(b - s) * size + i] = 255;       // bottom
      px[i * size + (a + s)] = 255;       // left
      px[i * size + (b - s)] = 255;       // right
    }
  }

  // downward arrow centred
  const cx = Math.floor(size / 2);
  const arrowTop = a + Math.round(size * 0.25);
  const arrowBot = b - Math.round(size * 0.20);
  // shaft
  for (let y = arrowTop; y <= arrowBot - Math.round(size * 0.18); y++) {
    for (let s = 0; s < stroke; s++) {
      px[y * size + cx + s - Math.floor(stroke / 2)] = 255;
    }
  }
  // arrow head (V)
  const headLen = Math.round(size * 0.22);
  for (let i = 0; i < headLen; i++) {
    const y = arrowBot - i;
    for (let s = 0; s < stroke; s++) {
      const off = i;
      px[y * size + (cx - off) + s] = 255;
      px[y * size + (cx + off) - s] = 255;
    }
  }

  return px;
}

function drawUnread(size) {
  const px = drawIdle(size);
  // dot badge in the top-right corner
  const r = Math.max(1, Math.round(size * 0.18));
  const cx = size - r - 1;
  const cy = r + 1;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y <= r * r) {
        const yy = cy + y;
        const xx = cx + x;
        if (yy >= 0 && yy < size && xx >= 0 && xx < size) {
          px[yy * size + xx] = 255;
        }
      }
    }
  }
  return px;
}

function writeIcon(filename, size, drawer) {
  const buf = encodePng(size, size, drawer(size));
  const out = path.join(__dirname, '..', 'assets', filename);
  fs.writeFileSync(out, buf);
  console.log(`wrote ${filename} (${size}x${size}, ${buf.length}b)`);
}

fs.mkdirSync(path.join(__dirname, '..', 'assets'), { recursive: true });

writeIcon('iconTemplate.png', 16, drawIdle);
writeIcon('iconTemplate@2x.png', 32, drawIdle);
writeIcon('iconTemplate@3x.png', 48, drawIdle);
writeIcon('icon-unreadTemplate.png', 16, drawUnread);
writeIcon('icon-unreadTemplate@2x.png', 32, drawUnread);
writeIcon('icon-unreadTemplate@3x.png', 48, drawUnread);
