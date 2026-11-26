import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EMAIL_ATTACHMENT_MB,
  FIT_TARGETS,
  MB_BYTES,
  SMALL_TARGET_MB,
  formatMb,
  largestOver,
  normalizeTargetMb,
  renamed,
  serverFit,
  shares,
  summaryLine,
  whereItFits,
} from '../src/lib/fit.js';
import { parseCatalog } from '../src/lib/formats.js';
import { FORMATS_BODY } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MB = MB_BYTES;
const catalog = parseCatalog({
  formats: [
    ...FORMATS_BODY.formats,
    { id: 'wav', name: 'WAV', category: 'audio', extensions: ['wav'], to: ['mp3', 'm4a'] },
    {
      id: 'mp3',
      name: 'MP3',
      category: 'audio',
      extensions: ['mp3'],
      to: ['m4a', 'wav'],
      compress: true,
    },
    { id: 'tiff', name: 'TIFF', category: 'image', extensions: ['tiff', 'tif'], to: ['jpg'] },
    { id: 'gif', name: 'GIF', category: 'image', extensions: ['gif'], to: ['jpg', 'mp4'] },
  ],
});

describe('the size targets', () => {
  it("copies Converter Studio's own EMAIL_ATTACHMENT_MB (packages/shared)", (t) => {
    // In the monorepo only; the add-on's public repository has no packages/.
    const shared = path.resolve(HERE, '../../../packages/shared/src/options.ts');
    if (!fs.existsSync(shared)) return t.skip('packages/shared is not here');
    const match = /export const EMAIL_ATTACHMENT_MB = (\d+);/.exec(fs.readFileSync(shared, 'utf8'));
    assert.ok(match, 'EMAIL_ATTACHMENT_MB in packages/shared/src/options.ts');
    assert.equal(EMAIL_ATTACHMENT_MB, Number(match[1]));
  });

  it('offers 16 MB (the default) and 10 MB', () => {
    assert.deepEqual(
      FIT_TARGETS.map((t) => t.mb),
      [16, 10],
    );
    assert.equal(normalizeTargetMb(undefined), 16);
    assert.equal(normalizeTargetMb('10'), 10);
    assert.equal(normalizeTargetMb(12), 16);
    assert.equal(SMALL_TARGET_MB, 10);
  });

  it('names the mail services a total gets through', () => {
    assert.equal(whereItFits(16 * MB), 'Fits Gmail and Yahoo Mail.');
    assert.equal(whereItFits(10 * MB), 'Fits Gmail, Yahoo Mail, Outlook.com and iCloud Mail.');
    assert.equal(whereItFits(16 * MB + 1), '');
  });

  it('sums up in one line', () => {
    assert.equal(
      summaryLine({ count: 4, before: 31.2 * MB, after: 14.8 * MB, targetMb: 16 }),
      '4 attachments, 31.2 MB → 14.8 MB. Fits Gmail and Yahoo Mail.',
    );
    assert.equal(
      summaryLine({ count: 1, before: 31.2 * MB, after: 12 * MB, targetMb: 10 }),
      '1 attachment, 31.2 MB → 12.0 MB. Still over 10 MB. Fits Gmail and Yahoo Mail.',
    );
    assert.equal(
      summaryLine({ count: 2, before: 40 * MB, after: 30 * MB, targetMb: 16 }),
      '2 attachments, 40.0 MB → 30.0 MB. Still over 16 MB.',
    );
    assert.equal(formatMb(850_000), '850 KB');
  });
});

describe('sharing the budget', () => {
  it('leaves small files whole and splits the rest evenly among the large', () => {
    assert.deepEqual(shares([1, 9, 9], 11), [1, 5, 5]);
    assert.deepEqual(shares([2, 3], 10), [2, 3]);
    assert.deepEqual(shares([8, 8, 8, 8], 16), [4, 4, 4, 4]);
    assert.deepEqual(shares([5, 5], 0), [0, 0]);
    assert.deepEqual(shares([5, 5], -3), [0, 0]);
    const s = shares(
      [0.2, 6, 6, 6, 12].map((x) => x * MB),
      16 * MB,
    );
    assert.ok(s.reduce((a, b) => a + b, 0) <= 16 * MB);
    assert.equal(s[0], 0.2 * MB);
  });

  it('names the largest attachments that make up what is over', () => {
    const items = [
      { name: 'a', size: 2 * MB },
      { name: 'video', size: 30 * MB },
      { name: 'b', size: 3 * MB },
    ];
    assert.deepEqual(
      largestOver(items, 16 * MB).map((i) => i.name),
      ['video'],
    );
    assert.deepEqual(
      largestOver(items, 1 * MB).map((i) => i.name),
      ['video', 'b', 'a'],
    );
    assert.deepEqual(largestOver(items, 40 * MB), []);
  });
});

describe('what the server is asked for', () => {
  it('a PDF: compressed with "Fit for email"', () => {
    assert.deepEqual(serverFit(catalog, 'Report.PDF', 15 * MB), {
      from: 'pdf',
      to: 'pdf',
      options: { emailFit: true, compression: 'balanced' },
    });
  });

  it('a video: an MP4 within its share', () => {
    assert.deepEqual(serverFit(catalog, 'clip.mov', 20 * MB), {
      from: 'mov',
      to: 'mp4',
      options: { emailFit: true },
    });
    assert.deepEqual(serverFit(catalog, 'clip.mov', 9.5 * MB).options, {
      emailFit: true,
      maxSize: 9,
    });
    assert.deepEqual(serverFit(catalog, 'clip.mov', 0.2 * MB).options.maxSize, 1);
  });

  it('an MP4 stays an MP4: made smaller in its own format, within its share', () => {
    assert.deepEqual(serverFit(catalog, 'phone.mp4', 5 * MB), {
      from: 'mp4',
      to: 'mp4',
      options: { emailFit: true, maxSize: 5 },
    });
    assert.deepEqual(serverFit(catalog, 'PHONE.M4V', 30 * MB), {
      from: 'mp4',
      to: 'mp4',
      options: { emailFit: true },
    });
  });

  it('a sound: an MP3; an MP3 stays an MP3', () => {
    assert.deepEqual(serverFit(catalog, 'talk.wav', MB), {
      from: 'wav',
      to: 'mp3',
      options: { emailFit: true },
    });
    assert.deepEqual(serverFit(catalog, 'song.mp3', MB), {
      from: 'mp3',
      to: 'mp3',
      options: { emailFit: true },
    });
  });

  it('a server without the same-format compression: an MP4 becomes a MOV, an MP3 an M4A', () => {
    // As servers before 2026-11-26 answered: no `compress`.
    const before = parseCatalog({
      formats: catalog.formats.map((format) => ({ ...format, compress: undefined })),
    });
    assert.deepEqual(serverFit(before, 'phone.mp4', 5 * MB), {
      from: 'mp4',
      to: 'mov',
      options: { emailFit: true },
    });
    assert.equal(serverFit(before, 'song.mp3', MB).to, 'm4a');
    assert.equal(serverFit(before, 'clip.mov', MB).to, 'mp4');
    assert.equal(serverFit(before, 'Report.pdf', MB).to, 'pdf');
    // Neither its own format nor the old one: nothing.
    const bare = parseCatalog({
      formats: [{ id: 'mp4', category: 'video', extensions: ['mp4'], to: ['mp3'] }],
    });
    assert.equal(serverFit(bare, 'phone.mp4', MB), null);
  });

  it('its own format only where the server lists it, in `to` or as `compress`', () => {
    const jpg = (more) =>
      parseCatalog({
        formats: [{ id: 'jpg', category: 'image', extensions: ['jpg'], to: ['png'], ...more }],
      });
    assert.equal(serverFit(jpg({}), 'scan.jpg', MB), null);
    assert.equal(serverFit(jpg({ compress: true }), 'scan.jpg', MB).to, 'jpg');
    assert.equal(serverFit(jpg({ to: ['jpg', 'png'] }), 'scan.jpg', MB).to, 'jpg');
  });

  it('a photo this computer cannot read: a JPG within its share', () => {
    assert.deepEqual(serverFit(catalog, 'scan.tiff', 2.5 * MB), {
      from: 'tiff',
      to: 'jpg',
      options: { emailFit: true, maxKb: 2500 },
    });
    assert.equal(serverFit(catalog, 'IMG_1.HEIC', 900 * MB).options.maxKb, 100_000);
    assert.equal(serverFit(catalog, 'IMG_1.HEIC', 10).options.maxKb, 5);
  });

  it('nothing for what has no smaller form: documents, archives, animations, unknown files', () => {
    for (const name of ['Report.docx', 'photos.zip', 'cat.gif', 'notes.txt', 'data.xyz'])
      assert.equal(serverFit(catalog, name, MB), null, name);
  });

  it('nothing when the catalogue has no such conversion', () => {
    const bare = parseCatalog({
      formats: [
        { id: 'pdf', name: 'PDF', category: 'document', extensions: ['pdf'], to: ['docx'] },
      ],
    });
    assert.equal(serverFit(bare, 'a.pdf', MB), null);
  });
});

describe('names', () => {
  it('change the extension only when the type changes', () => {
    const jpg = ['jpg', 'jpeg', 'jpe', 'jfif'];
    assert.equal(renamed('IMG_0001.HEIC', jpg), 'IMG_0001.jpg');
    assert.equal(renamed('Photo.JPEG', jpg), 'Photo.JPEG');
    assert.equal(renamed('screenshot.png', jpg), 'screenshot.jpg');
    assert.equal(renamed('logo.png', ['png']), 'logo.png');
    assert.equal(renamed('noextension', jpg), 'noextension.jpg');
    assert.equal(renamed('.hidden', jpg), '.hidden.jpg');
  });
});
