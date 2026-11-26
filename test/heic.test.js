import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeHeic } from '../src/lib/heic.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(HERE, '../src/vendor/libheif-js');

describe('libheif (vendor/libheif-js)', () => {
  it('is the official 1.23.5 release, unchanged, as VENDOR.md declares it', () => {
    const vendor = fs.readFileSync(path.resolve(VENDOR, '../../VENDOR.md'), 'utf8');
    // The declaration Thunderbird's linter (and ATN's reviewers) verify against the release.
    assert.match(
      vendor,
      /^directory: vendor\/libheif-js\nsource: https:\/\/cdn\.jsdelivr\.net\/npm\/libheif-js@1\.23\.5\/$/m,
    );
    for (const file of ['libheif-wasm/libheif-bundle.mjs', 'libheif-wasm/LICENSE', 'LICENSE']) {
      const hash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(VENDOR, file)))
        .digest('hex');
      assert.ok(vendor.includes(`- \`vendor/libheif-js/${file}\`: \`${hash}\``), file);
    }
    // Nothing else in the folder: the release's files at their own paths.
    const files = fs
      .readdirSync(VENDOR, { recursive: true })
      .filter((f) => fs.statSync(path.join(VENDOR, f)).isFile())
      .sort();
    assert.deepEqual(files, ['LICENSE', 'libheif-wasm/LICENSE', 'libheif-wasm/libheif-bundle.mjs']);
  });

  it('is the same file the browser extension ships (in the monorepo)', (t) => {
    const theirs = path.resolve(
      HERE,
      '../../../apps/extension/node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs',
    );
    if (!fs.existsSync(theirs)) return t.skip('apps/extension is not installed here');
    const ours = fs.readFileSync(path.join(VENDOR, 'libheif-wasm/libheif-bundle.mjs'));
    assert.ok(ours.equals(fs.readFileSync(theirs)));
  });

  it('decodes a HEIC photo the right way up (its irot turn applied)', async () => {
    // Stored sideways (160 × 480) with a 90° turn; upright, a red block is in the top right.
    const bytes = new Uint8Array(fs.readFileSync(path.join(HERE, 'data/sideways.heic')));
    const { width, height, data } = await decodeHeic(bytes);
    assert.deepEqual([width, height], [480, 160]);
    assert.equal(data.length, width * height * 4);
    const pixel = (x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
    const [r, g, b, a] = pixel(width - 8, 8);
    assert.ok(r > 180 && g < 80 && b < 80 && a === 255, `top right ${[r, g, b, a]}`);
    const [r2, g2, b2] = pixel(8, height - 8);
    assert.ok(!(r2 > 180 && g2 < 80 && b2 < 80), `bottom left ${[r2, g2, b2]}`);
  });

  it('refuses a file that is not a HEIC photo', async () => {
    await assert.rejects(decodeHeic(new Uint8Array(4096)));
  });
});
