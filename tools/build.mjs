/**
 * Packs src/ into dist/converter-studio-<version>.xpi, the file uploaded to addons.thunderbird.net.
 * The add-on is the source as it is (no bundler, no minifier), so the XPI holds exactly the files
 * of src/: a plain ZIP, written here with Node's zlib so the build needs no dependencies, with
 * fixed dates so the same source always gives the same file.
 *
 *   node tools/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

/** Every file under a folder, as forward-slash paths, sorted. */
function files(dir, prefix = '') {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.')) return [];
      return entry.isDirectory() ? files(path.join(dir, entry.name), relative) : [relative];
    })
    .sort();
}

// 2026-01-01 00:00 in MS-DOS time and date.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version)
    throw new Error(
      `manifest.json says ${manifest.version}, package.json ${pkg.version}: change both`,
    );
  const entries = files(SRC).map((name) => ({ name, data: fs.readFileSync(path.join(SRC, name)) }));
  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, `converter-studio-${manifest.version}.xpi`);
  fs.writeFileSync(out, zip(entries));
  return { out, count: entries.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { out, count } = build();
  console.log(
    `${path.relative(process.cwd(), out)}: ${count} files, ${fs.statSync(out).size} bytes`,
  );
}
