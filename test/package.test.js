import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { zip } from '../tools/build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const sources = walk(SRC);
const code = sources
  .filter((f) => /\.(js|html)$/.test(f))
  .map((f) => ({ f: path.relative(SRC, f), text: fs.readFileSync(f, 'utf8') }));

describe('the manifest', () => {
  it('is Manifest V3 for the current ESR (153) and release', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '153.0');
    assert.equal(manifest.browser_specific_settings.gecko.strict_max_version, undefined);
    assert.equal(manifest.browser_specific_settings.gecko.id, 'thunderbird@converter.studio');
  });

  it('has the same version as package.json (the client header reads it)', () => {
    assert.equal(manifest.version, pkg.version);
  });

  it('asks for the least: compose, storage and the upload notice at install; the rest when used', () => {
    assert.deepEqual(manifest.permissions, ['compose', 'storage', 'sensitiveDataUpload']);
    assert.deepEqual(manifest.optional_permissions, ['messagesRead', 'downloads']);
    assert.deepEqual(manifest.host_permissions, ['https://converter.studio/*']);
    assert.deepEqual(manifest.optional_host_permissions, [
      'http://localhost/*',
      'http://127.0.0.1/*',
      'https://localhost/*',
      'https://127.0.0.1/*',
    ]);
  });

  it('names Converter Studio and links to converter.studio', () => {
    assert.equal(manifest.name, 'Converter Studio');
    assert.equal(manifest.author, 'Converter Studio');
    assert.equal(manifest.homepage_url, 'https://converter.studio');
    // The listing's summary starts as this text; ATN allows 250 characters.
    assert.ok(manifest.description.length <= 250, `${manifest.description.length} characters`);
  });

  it('points only at files that exist', () => {
    const referenced = [
      ...Object.values(manifest.icons),
      ...manifest.background.scripts,
      manifest.compose_action.default_popup,
      manifest.message_display_action.default_popup,
      manifest.options_ui.page,
      manifest.compose_action.default_icon,
      ...manifest.compose_action.theme_icons.flatMap((i) => [i.light, i.dark]),
    ];
    for (const file of referenced) assert.ok(fs.existsSync(path.join(SRC, file)), file);
    for (const { f, text } of code.filter((c) => c.f.endsWith('.html')))
      for (const [, ref] of text.matchAll(/(?:src|href)="([^"]+)"/g))
        if (!/^https:\/\//.test(ref))
          assert.ok(fs.existsSync(path.join(SRC, path.dirname(f), ref)), `${f}: ${ref}`);
  });
});

describe('the code ATN reviews', () => {
  it('loads no remote code and builds no code from strings', () => {
    for (const { f, text } of code) {
      assert.doesNotMatch(text, /<script[^>]+src="https?:/, f);
      assert.doesNotMatch(
        text,
        /\beval\(|new Function\(|\.innerHTML\s*=|insertAdjacentHTML|document\.write/,
        f,
      );
      assert.doesNotMatch(text, /import\(\s*['"`]https?:/, f);
    }
  });

  it('is not minified (short lines, readable names)', () => {
    for (const { f, text } of code)
      for (const line of text.split('\n'))
        assert.ok(line.length <= 200, `${f}: a line of ${line.length} characters`);
  });

  it('sends nothing anywhere but the Converter Studio address (no analytics)', () => {
    for (const { f, text } of code) {
      const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
      for (const host of hosts)
        assert.ok(['converter.studio', 'localhost', '127.0.0.1'].includes(host), `${f}: ${host}`);
    }
  });
});

describe('the build', () => {
  it('writes a ZIP that holds the files unchanged', () => {
    const data = Buffer.from('hello hello hello hello');
    const archive = zip([{ name: 'a/b.txt', data }]);
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    const nameLength = archive.readUInt16LE(26);
    const size = archive.readUInt32LE(18);
    const method = archive.readUInt16LE(8);
    const body = archive.subarray(30 + nameLength, 30 + nameLength + size);
    assert.equal(archive.subarray(30, 30 + nameLength).toString(), 'a/b.txt');
    assert.deepEqual(method === 8 ? zlib.inflateRawSync(body) : body, data);
    assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  });
});
