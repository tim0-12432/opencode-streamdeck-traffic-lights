#!/usr/bin/env node
/**
 * Zero-dependency PNG generator for every image the plugin ships.
 *
 * WHY A GENERATOR INSTEAD OF CHECKED-IN BINARIES
 *
 * The plugin used to reference Elgato's stock `Counter` sample assets: a 20x20
 * plus-sign action icon, Elgato's own logo as the Marketplace + category icons
 * (a trademark problem), and a stock key image. None of them rendered, because
 * the manifest paths did not resolve -- Stream Deck showed a grey three-circles
 * placeholder instead. Rather than author PNGs by hand (which we cannot do
 * meaningfully in a text repo and cannot review in a diff), the real traffic-light
 * artwork is *generated from code* here: no image library, only Node's built-in
 * `zlib.deflateSync` and a hand-rolled CRC32. Editing an image = editing a number
 * in this file, and it is reviewable in a diff.
 *
 * COMMITTED, NOT GITIGNORED
 *
 * The generated PNGs ARE committed. They are runtime assets the plugin loads
 * from its own folder at run time (both the manifest and `fallbackImage()` read
 * them from disk), so a fresh clone must already contain them -- the build is not
 * a prerequisite for the plugin to work. `.gitignore` ignores `*.sdPlugin/bin`
 * (the compiled bundle) but deliberately NOT `imgs/`. The generator is
 * deterministic (fixed zlib level, no timestamps, fixed iteration order), so
 * re-running it produces byte-identical files and a dirty tree stays clean.
 *
 * DETERMINISM
 *
 * `deflateSync` at a fixed level is deterministic for a given zlib build, and
 * nothing here embeds a clock, a random seed or filesystem order, so two runs on
 * the same machine yield identical bytes. (Across a *different* zlib the
 * compressed stream could differ byte-for-byte while decoding to the identical
 * image; the decoded pixels are always the same.)
 *
 * PNG FORMAT
 *
 * 8-byte signature, then IHDR / IDAT / IEND, each chunk as
 * big-endian length + 4 ASCII type bytes + data + CRC32 (over type+data).
 * Colour type 6 (RGBA, 8-bit), no interlacing, and every scanline is prefixed
 * with filter byte 0 (None) so the image decodes with a plain inflate. The CRC32
 * is implemented by hand rather than trusting `zlib.crc32`, which is a recent
 * Node addition and not present in every runtime the plugin targets.
 *
 * Runs on Windows and macOS with no shell features: paths come from `node:path`
 * and directories are created with `node:fs`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', 'com.tim0-12432.opencode-traffic-lights.sdPlugin');

// ---------------------------------------------------------------------------
// CRC32 (PNG chunk checksum). Table-driven, no dependencies.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Buffer|Uint8Array} bytes @returns {number} unsigned 32-bit CRC */
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG encoding.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * @param {number} width @param {number} height @param {Buffer} rgba w*h*4 bytes
 * @returns {Buffer} a complete 8-bit RGBA PNG
 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha (RGBA)
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive (per-scanline filter bytes)
  ihdr[12] = 0; // interlace: none

  // Raw scanlines, each prefixed with filter byte 0 (None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + stride);
  }

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// A tiny antialiased software rasteriser.
// ---------------------------------------------------------------------------

/** @param {string} hex `#rrggbb` or `#rrggbbaa` @returns {[number,number,number,number]} */
function rgba(hex) {
  const h = hex.replace('#', '');
  const v = (i) => parseInt(h.slice(i, i + 2), 16);
  return [v(0), v(2), v(4), h.length === 8 ? v(6) : 255];
}

function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

/** Inside-test for a disc centred at (cx,cy). */
const disc = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/**
 * Inside-test for a rounded rectangle centred at (cx,cy) of size w x h with
 * corner radius r (clamped so the radius never exceeds half the shorter side).
 */
const roundedRect = (cx, cy, w, h, r) => {
  const hw = w / 2;
  const hh = h / 2;
  const rad = Math.min(r, hw, hh);
  const ix = hw - rad;
  const iy = hh - rad;
  return (x, y) => {
    const dx = Math.max(Math.abs(x - cx) - ix, 0);
    const dy = Math.max(Math.abs(y - cy) - iy, 0);
    return dx * dx + dy * dy <= rad * rad;
  };
};

/** The whole canvas, for backgrounds. */
const everywhere = () => () => true;

const SUBSAMPLES = 4; // 4x4 = 16 samples per pixel, for smooth edges

/**
 * Paints `shape` onto `canvas` with `colour` using supersampled coverage
 * (source-over blending), so circles get antialiased edges.
 */
function paint(canvas, shape, colour) {
  const [sr, sg, sb, sa] = colour;
  const { width, height, data } = canvas;
  const step = 1 / SUBSAMPLES;
  const offset = step / 2;
  const total = SUBSAMPLES * SUBSAMPLES;

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
        for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
          if (shape(px + offset + sx * step, py + offset + sy * step)) hits += 1;
        }
      }
      if (hits === 0) continue;

      const coverage = hits / total;
      const i = (py * width + px) * 4;
      const da = data[i + 3] / 255;
      const srcA = (sa / 255) * coverage;
      const outA = srcA + da * (1 - srcA);
      if (outA <= 0) continue;
      const wR = sr * srcA;
      const wG = sg * srcA;
      const wB = sb * srcA;
      data[i] = Math.round((wR + data[i] * da * (1 - srcA)) / outA);
      data[i + 1] = Math.round((wG + data[i + 1] * da * (1 - srcA)) / outA);
      data[i + 2] = Math.round((wB + data[i + 2] * da * (1 - srcA)) / outA);
      data[i + 3] = Math.round(outA * 255);
    }
  }
}

// ---------------------------------------------------------------------------
// Artwork.
// ---------------------------------------------------------------------------

/** The traffic-light palette, kept identical to the manifest/contract. */
const BACKGROUND = rgba('#171717');
const LAMP_RED = rgba('#ef4444');
const LAMP_AMBER = rgba('#eab308');
const LAMP_GREEN = rgba('#22c55e');

/**
 * The key's state image: the exact geometry the old SVG fallback drew -- a
 * #171717 square with a filled disc of radius 49/144 of the width, centred.
 * Kept pixel-for-pixel equivalent in appearance so the fix changes how the
 * image is TRANSPORTED (base64 data-URL) without changing how it looks.
 */
function drawStateImage(size, lampColour) {
  const canvas = createCanvas(size, size);
  paint(canvas, everywhere(), BACKGROUND);
  paint(canvas, disc(size / 2, size / 2, (size * 49) / 144), lampColour);
  return canvas;
}

/**
 * The three-lamp vertical signal -- the shared glyph for the action icon, the
 * category icon and the Marketplace icon. Lamp centres are at 22%/50%/78% of
 * the height with a radius of 13% of the size, so the same shape reads at 28px
 * and at 1024px.
 */
function drawTrafficLight(size, { background, housing, lampColours }) {
  const canvas = createCanvas(size, size);
  if (background) paint(canvas, everywhere(), background);
  if (housing) {
    // A capsule around the lamp column, inset from the top/bottom lamps.
    paint(canvas, roundedRect(size / 2, size * 0.5, size * 0.35, size * 0.9, size * 0.175), housing);
  }
  const radius = size * 0.13;
  const centres = [0.22, 0.5, 0.78];
  centres.forEach((fy, i) => {
    paint(canvas, disc(size / 2, size * fy, radius), lampColours[i]);
  });
  return canvas;
}

// ---------------------------------------------------------------------------
// The assets to write. `size` is the 1x width; a `@2x` twin is written too.
// ---------------------------------------------------------------------------

const KEY_LAMPS = { green: LAMP_GREEN, yellow: LAMP_AMBER, red: LAMP_RED };
const HOUSING = rgba('#262626');

/** @type {{file: string, canvas: {width:number,height:number,data:Buffer}}[]} */
function buildAssets() {
  /** @type {any[]} */
  const assets = [];

  // 1. The three key state images (72x72 + 144x144 @2x).
  for (const [state, colour] of Object.entries(KEY_LAMPS)) {
    assets.push({
      file: `imgs/actions/status/${state}.png`,
      canvas: drawStateImage(72, colour),
    });
    assets.push({
      file: `imgs/actions/status/${state}@2x.png`,
      canvas: drawStateImage(144, colour),
    });
  }

  // 2. The action-list icon: the same three-lamp glyph, full colour on the
  //    dark background, legible down to the smallest action-list thumbnail.
  assets.push({
    file: 'imgs/actions/status/icon.png',
    canvas: drawTrafficLight(72, {
      background: BACKGROUND,
      housing: null,
      lampColours: [LAMP_RED, LAMP_AMBER, LAMP_GREEN],
    }),
  });
  assets.push({
    file: 'imgs/actions/status/icon@2x.png',
    canvas: drawTrafficLight(144, {
      background: BACKGROUND,
      housing: null,
      lampColours: [LAMP_RED, LAMP_AMBER, LAMP_GREEN],
    }),
  });

  // 3. The category icon: Elgato requires a MONOCHROME icon on a fully
  //    TRANSPARENT background, so it is the same glyph in flat #FFFFFF with
  //    no background and no housing.
  const WHITE = rgba('#FFFFFF');
  assets.push({
    file: 'imgs/plugin/category-icon.png',
    canvas: drawTrafficLight(28, {
      background: null,
      housing: null,
      lampColours: [WHITE, WHITE, WHITE],
    }),
  });
  assets.push({
    file: 'imgs/plugin/category-icon@2x.png',
    canvas: drawTrafficLight(56, {
      background: null,
      housing: null,
      lampColours: [WHITE, WHITE, WHITE],
    }),
  });

  // 4. The Marketplace icon: the glyph at poster size, on a dark background
  //    with a recessed housing so it reads as a signal. This replaces
  //    Elgato's own logo, which we must not ship.
  assets.push({
    file: 'imgs/plugin/marketplace.png',
    canvas: drawTrafficLight(512, {
      background: BACKGROUND,
      housing: HOUSING,
      lampColours: [LAMP_RED, LAMP_AMBER, LAMP_GREEN],
    }),
  });
  assets.push({
    file: 'imgs/plugin/marketplace@2x.png',
    canvas: drawTrafficLight(1024, {
      background: BACKGROUND,
      housing: HOUSING,
      lampColours: [LAMP_RED, LAMP_AMBER, LAMP_GREEN],
    }),
  });

  return assets;
}

// ---------------------------------------------------------------------------
// Write everything out.
// ---------------------------------------------------------------------------

let written = 0;
for (const { file, canvas } of buildAssets()) {
  const png = encodePng(canvas.width, canvas.height, canvas.data);
  const target = path.join(PLUGIN_ROOT, ...file.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
  written += 1;
}
console.log(`${written} image(s) generated under ${PLUGIN_ROOT}`);
