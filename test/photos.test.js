import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  QUALITY,
  fitDimensions,
  longSidesFor,
  readPhoto,
  searchQuality,
  shrinkPhoto,
  sniff,
} from '../src/lib/photos.js';

const bytes = (text, pad = 32) => {
  const out = new Uint8Array(Math.max(pad, text.length));
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
};
/** An ISO-BMFF `ftyp` box with these brands (major, minor version, compatible…). */
function ftyp(major, ...compatible) {
  const size = 16 + compatible.length * 4;
  const box = bytes(`\0\0\0${String.fromCharCode(size)}ftyp${major}\0\0\0\0${compatible.join('')}`);
  return box;
}

/**
 * A fake canvas: files whose size follows the pixels and the quality (a JPEG of 2048 × 1536 at
 * 0.85 is about 1.3 MB), and a record of every resize and encode.
 */
function fakeBackend({ transparent = false, webp = true } = {}) {
  const calls = { resize: [], encode: [], released: 0 };
  const perPixel = { 'image/jpeg': 0.5, 'image/webp': 0.35, 'image/png': 2 };
  return {
    calls,
    async decode(file, kind) {
      if (kind === 'broken') throw new Error('cannot decode');
      return { width: file.width, height: file.height };
    },
    async transparent() {
      return transparent;
    },
    async resize(image, width, height, background) {
      calls.resize.push({ width, height, background });
      return { width, height };
    },
    async encode(canvas, type, quality = 1) {
      if (type === 'image/webp' && !webp) throw new Error('no webp');
      calls.encode.push({ width: canvas.width, height: canvas.height, type, quality });
      const lossy = type === 'image/png' ? 1 : quality;
      return new Blob(
        [new Uint8Array(Math.round(canvas.width * canvas.height * perPixel[type] * lossy))],
        { type },
      );
    },
    release() {
      calls.released++;
    },
  };
}

const photo = (kind, width = 4032, height = 3024, opaque = true) => ({
  kind,
  image: { width, height },
  width,
  height,
  opaque,
});
const MB = 1_000_000;

describe('telling photos apart by their first bytes', () => {
  it('knows JPEG, PNG, WebP and HEIC, and nothing else', () => {
    assert.equal(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...new Array(28).fill(0)])), 'jpeg');
    assert.equal(sniff(bytes('\x89PNG\r\n\x1a\n')), 'png');
    assert.equal(sniff(bytes('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
    assert.equal(sniff(ftyp('heic', 'mif1', 'heic')), 'heic');
    // A generic HEIF brand first, an HEVC picture inside.
    assert.equal(sniff(ftyp('mif1', 'mif1', 'heic')), 'heic');
    assert.equal(sniff(ftyp('avif', 'avif', 'mif1')), null);
    assert.equal(sniff(ftyp('isom', 'isom', 'mp41')), null);
    assert.equal(sniff(bytes('%PDF-1.7')), null);
    assert.equal(sniff(new Uint8Array(4)), null);
  });
});

describe('sizes', () => {
  it('fits the long side, never enlarging', () => {
    assert.deepEqual(fitDimensions(4032, 3024, 2048), { width: 2048, height: 1536 });
    assert.deepEqual(fitDimensions(3024, 4032, 1600), { width: 1200, height: 1600 });
    assert.deepEqual(fitDimensions(800, 600, 2048), { width: 800, height: 600 });
  });

  it('tries 2048, 1600 and 1280 px, below the photo’s own size', () => {
    assert.deepEqual(longSidesFor(4032, 3024), [2048, 1600, 1280]);
    assert.deepEqual(longSidesFor(1000, 1800), [1800, 1600, 1280]);
    assert.deepEqual(longSidesFor(1000, 800), [1000]);
  });
});

describe('the quality search', () => {
  const sizeAt = (quality) => new Blob([new Uint8Array(Math.round(quality * 1000))]);

  it('keeps the starting quality when it fits, with one encode', async () => {
    const asked = [];
    const { blob, fits } = await searchQuality(async (q) => (asked.push(q), sizeAt(q)), 900);
    assert.equal(fits, true);
    assert.equal(blob.size, 850);
    assert.deepEqual(asked, [QUALITY.start]);
  });

  it('finds a high quality under the limit', async () => {
    const asked = [];
    const { blob, fits } = await searchQuality(async (q) => (asked.push(q), sizeAt(q)), 700);
    assert.equal(fits, true);
    assert.ok(blob.size <= 700 && blob.size >= 650, `${blob.size}`);
    assert.ok(asked.length <= 6, asked.join());
  });

  it('says so when not even the lowest quality fits', async () => {
    const { blob, fits } = await searchQuality(async (q) => sizeAt(q), 400);
    assert.equal(fits, false);
    assert.equal(blob.size, 500);
  });
});

describe('making a photo smaller', () => {
  it('first step: 2048 px at quality 0.85, the name and type kept', async () => {
    const backend = fakeBackend();
    const result = await shrinkPhoto(photo('jpeg'), { name: 'IMG_1.JPG', size: 6 * MB }, backend);
    assert.equal(result.name, 'IMG_1.JPG');
    assert.equal(result.type, 'image/jpeg');
    assert.deepEqual(backend.calls.encode, [
      { width: 2048, height: 1536, type: 'image/jpeg', quality: 0.85 },
    ]);
    // A JPEG is drawn on white (a see-through pixel would turn black).
    assert.equal(backend.calls.resize[0].background, '#ffffff');
    assert.equal(backend.calls.released, 1);
  });

  it('keeps the photo when its copy would not be smaller', async () => {
    const backend = fakeBackend();
    const result = await shrinkPhoto(
      photo('jpeg', 1200, 900),
      { name: 'a.jpg', size: 300_000 },
      backend,
    );
    assert.equal(result, null);
  });

  it('turns a HEIC photo into a JPG', async () => {
    const result = await shrinkPhoto(
      photo('heic'),
      { name: 'IMG_0001.HEIC', size: 3 * MB },
      fakeBackend(),
    );
    assert.equal(result.name, 'IMG_0001.jpg');
    assert.equal(result.type, 'image/jpeg');
  });

  it('keeps a WebP a WebP', async () => {
    const result = await shrinkPhoto(
      photo('webp'),
      { name: 'a.webp', size: 3 * MB },
      fakeBackend(),
    );
    assert.equal(result.name, 'a.webp');
    assert.equal(result.type, 'image/webp');
  });

  it('with a share: lower quality first, then smaller steps, the first that fits', async () => {
    const backend = fakeBackend();
    // 2048 × 1536 at 0.5 is about 0.79 MB; 1600 × 1200 at 0.85 about 0.82 MB.
    const result = await shrinkPhoto(
      photo('jpeg'),
      { name: 'a.jpg', size: 6 * MB, share: 0.7 * MB },
      backend,
    );
    assert.ok(result.blob.size <= 0.7 * MB, `${result.blob.size}`);
    const sides = [...new Set(backend.calls.encode.map((e) => e.width))];
    assert.deepEqual(sides, [2048, 1600]);
    const last = backend.calls.encode.at(-1);
    assert.ok(last.quality < 0.85 && last.quality >= 0.5, `${last.quality}`);
  });

  it('with a share nothing reaches: the smallest copy (1280 px, lowest quality)', async () => {
    const backend = fakeBackend();
    const result = await shrinkPhoto(
      photo('jpeg'),
      { name: 'a.jpg', size: 6 * MB, share: 1000 },
      backend,
    );
    assert.equal(result.blob.size, Math.round(1280 * 960 * 0.5 * 0.5));
    assert.equal(backend.calls.released, 3);
  });

  it('a PNG with transparency stays a PNG, only resized', async () => {
    const backend = fakeBackend();
    const png = photo('png', 4032, 3024, false);
    const first = await shrinkPhoto(png, { name: 'logo.png', size: 30 * MB }, backend);
    assert.equal(first.name, 'logo.png');
    assert.equal(first.type, 'image/png');
    const fitted = await shrinkPhoto(
      png,
      { name: 'logo.png', size: 30 * MB, share: 4 * MB },
      backend,
    );
    assert.equal(fitted.type, 'image/png');
    assert.equal(fitted.blob.size, 1600 * 1200 * 2);
    assert.ok(backend.calls.resize.every((r) => r.background === null));
    assert.ok(backend.calls.encode.every((e) => e.type === 'image/png'));
  });

  it('a PNG without transparency: resized first, a JPG only when it must get smaller still', async () => {
    const backend = fakeBackend();
    const png = photo('png', 4032, 3024, true);
    const first = await shrinkPhoto(png, { name: 'shot.png', size: 30 * MB }, backend);
    assert.equal(first.type, 'image/png');
    const fitted = await shrinkPhoto(
      png,
      { name: 'shot.png', size: 6 * MB, share: 2 * MB },
      backend,
    );
    assert.equal(fitted.type, 'image/jpeg');
    assert.equal(fitted.name, 'shot.jpg');
  });
});

describe('reading a photo', () => {
  it('checks a PNG for transparency', async () => {
    const file = { width: 100, height: 50 };
    const seeThrough = await readPhoto(file, 'png', fakeBackend({ transparent: true }));
    assert.equal(seeThrough.opaque, false);
    const solid = await readPhoto(file, 'png', fakeBackend());
    assert.equal(solid.opaque, true);
    assert.deepEqual([solid.width, solid.height], [100, 50]);
    assert.equal((await readPhoto(file, 'jpeg', fakeBackend({ transparent: true }))).opaque, true);
  });

  it('fails when the picture cannot be decoded', async () => {
    await assert.rejects(readPhoto({ width: 1, height: 1 }, 'broken', fakeBackend()));
  });
});
