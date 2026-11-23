import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultTarget,
  formatBytes,
  formatOf,
  optionsFor,
  outputName,
  parseCatalog,
  targetsFor,
} from '../src/lib/formats.js';
import { FORMATS_BODY } from './helpers.js';

const catalog = parseCatalog(FORMATS_BODY);

describe('the catalogue from the API', () => {
  it('finds a format by its extension, whatever the case', () => {
    assert.equal(formatOf(catalog, 'IMG_0001.HEIC'), 'heic');
    assert.equal(formatOf(catalog, 'photo.heif'), 'heic');
    assert.equal(formatOf(catalog, 'scan.JPEG'), 'jpg');
    assert.equal(formatOf(catalog, 'Report 2026.docx'), 'docx');
  });

  it('prefers the longest extension ("tar.gz" before "gz")', () => {
    assert.equal(formatOf(catalog, 'backup.tar.gz'), 'tgz');
    assert.equal(formatOf(catalog, 'log.gz'), 'gz');
  });

  it('knows nothing of names without a known extension', () => {
    assert.equal(formatOf(catalog, 'README'), null);
    assert.equal(formatOf(catalog, '.heic'), null);
    assert.equal(formatOf(catalog, 'virus.exe'), null);
  });

  it("offers the API's targets in the API's order, with names", () => {
    assert.deepEqual(
      targetsFor(catalog, 'heic').map((t) => `${t.to}:${t.label}`),
      ['jpg:JPG', 'pdf:PDF', 'png:PNG', 'webp:WebP'],
    );
    assert.deepEqual(targetsFor(catalog, null), []);
    assert.deepEqual(targetsFor(catalog, 'nope'), []);
  });

  it('calls PDF to PDF a smaller PDF, picks it first for PDFs, and asks for balanced compression', () => {
    assert.equal(
      targetsFor(catalog, 'pdf').find((t) => t.to === 'pdf').label,
      'PDF (smaller file)',
    );
    assert.equal(defaultTarget(catalog, 'pdf'), 'pdf');
    assert.deepEqual(optionsFor('pdf', 'pdf'), { compression: 'balanced' });
    assert.equal(optionsFor('heic', 'jpg'), undefined);
  });

  it("otherwise picks the API's first target", () => {
    assert.equal(defaultTarget(catalog, 'heic'), 'jpg');
    assert.equal(defaultTarget(catalog, 'docx'), 'pdf');
    assert.equal(defaultTarget(catalog, 'mov'), 'mp4');
    assert.equal(defaultTarget(catalog, null), null);
  });

  it('uses a name for targets that are not sources too', () => {
    assert.equal(targetsFor(catalog, 'zip')[0].label, '7Z');
  });

  it('skips malformed entries', () => {
    const c = parseCatalog({
      formats: [{ id: 'BAD ID' }, null, { id: 'ok', extensions: ['OK'], to: ['x', 3] }],
    });
    assert.deepEqual(
      c.formats.map((f) => f.id),
      ['ok'],
    );
    assert.deepEqual(c.formats[0].to, ['x']);
    assert.equal(formatOf(c, 'file.ok'), 'ok');
    assert.deepEqual(parseCatalog(null).formats, []);
  });
});

describe('names and sizes', () => {
  it('names the result with the target extension', () => {
    assert.equal(outputName(catalog, 'IMG_0001.HEIC', 'jpg'), 'IMG_0001.jpg');
    assert.equal(outputName(catalog, 'backup.tar.gz', 'zip'), 'backup.zip');
    assert.equal(outputName(catalog, 'notes', 'pdf'), 'notes.pdf');
    assert.equal(outputName(catalog, '', 'pdf'), 'file.pdf');
  });

  it('writes sizes as people read them', () => {
    assert.equal(formatBytes(12), '12 bytes');
    assert.equal(formatBytes(12_100), '12 KB');
    assert.equal(formatBytes(2_400_000), '2.4 MB');
    assert.equal(formatBytes(24_000_000), '24 MB');
    assert.equal(formatBytes(undefined), '');
  });
});
