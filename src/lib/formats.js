/**
 * What an attachment can become, from the API's own catalogue (`GET /v1/formats`): every format
 * Converter Studio reads, its file extensions, and the formats it converts to, most popular first.
 * Nothing here is a hard-coded list of conversions.
 */

/**
 * `compress`: the server makes the format smaller in its own format (MP4 → MP4, MP3 → MP3…, asked
 * for with a setting such as `emailFit`); false from servers before 2026-11-26.
 * @typedef {{ id: string, name: string, category: string, extensions: string[], to: string[], compress: boolean }} FormatView
 * @typedef {{ formats: FormatView[], byId: Map<string, FormatView>, byExtension: Map<string, string> }} Catalog
 */

/**
 * A catalogue from the API's answer; formats without an id or targets are left out.
 * @param {unknown} body the JSON of `GET /v1/formats`
 * @returns {Catalog}
 */
export function parseCatalog(body) {
  const list = Array.isArray(body?.formats) ? body.formats : [];
  const formats = [];
  for (const f of list) {
    if (!f || typeof f.id !== 'string' || !/^[a-z0-9]{1,10}$/.test(f.id)) continue;
    formats.push({
      id: f.id,
      name: typeof f.name === 'string' && f.name ? f.name : f.id.toUpperCase(),
      category: typeof f.category === 'string' ? f.category : 'other',
      extensions: Array.isArray(f.extensions)
        ? f.extensions.filter((e) => typeof e === 'string').map((e) => e.toLowerCase())
        : [],
      to: Array.isArray(f.to) ? f.to.filter((t) => typeof t === 'string') : [],
      compress: f.compress === true,
    });
  }
  const byId = new Map(formats.map((f) => [f.id, f]));
  const byExtension = new Map();
  for (const f of formats)
    for (const e of f.extensions) if (!byExtension.has(e)) byExtension.set(e, f.id);
  return { formats, byId, byExtension };
}

/**
 * The format a file is in, from the end of its name (`IMG_1.HEIC` → `heic`, `a.tar.gz` → the
 * format whose extension is `tar.gz`), or `null` when the catalogue knows none.
 * @param {Catalog} catalog
 * @param {string} fileName
 */
export function formatOf(catalog, fileName) {
  const name = String(fileName ?? '')
    .trim()
    .toLowerCase();
  // The longest known extension wins: "tar.gz" before "gz".
  let best = null;
  let bestLength = 0;
  for (const [extension, id] of catalog.byExtension) {
    if (
      extension.length > bestLength &&
      name.length > extension.length + 1 &&
      name.endsWith(`.${extension}`)
    ) {
      best = id;
      bestLength = extension.length;
    }
  }
  return best;
}

/** PDF to PDF is the API's "compress a PDF". */
export const isCompression = (from, to) => from === 'pdf' && to === 'pdf';

/**
 * The choices for a file of format `from`, in the API's order: `{ to, label }`.
 * @param {Catalog} catalog
 * @param {string | null} from
 */
export function targetsFor(catalog, from) {
  const source = from ? catalog.byId.get(from) : undefined;
  if (!source) return [];
  return source.to.map((to) => ({
    to,
    label: isCompression(from, to)
      ? 'PDF (smaller file)'
      : (catalog.byId.get(to)?.name ?? to.toUpperCase()),
  }));
}

/**
 * The target picked first: what most people want from a file of that kind (the API's first
 * target), except that a PDF is offered as a smaller PDF.
 */
export function defaultTarget(catalog, from) {
  const targets = targetsFor(catalog, from);
  if (targets.some((t) => isCompression(from, t.to))) return 'pdf';
  return targets[0]?.to ?? null;
}

/** The options sent with a conversion: only "balanced" compression for PDF to PDF. */
export const optionsFor = (from, to) =>
  isCompression(from, to) ? { compression: 'balanced' } : undefined;

/**
 * `IMG_0001.HEIC` → `IMG_0001.jpg`, with the target format's first extension from the catalogue.
 * @param {Catalog} catalog
 * @param {string} fileName
 * @param {string} to
 */
export function outputName(catalog, fileName, to) {
  const name = String(fileName ?? '').trim() || 'file';
  const from = formatOf(catalog, name);
  const known = from
    ? catalog.byId.get(from)?.extensions.find((e) => name.toLowerCase().endsWith(`.${e}`))
    : undefined;
  const base = known ? name.slice(0, name.length - known.length - 1) : name;
  const extension = catalog.byId.get(to)?.extensions[0] ?? to;
  return `${base}.${extension}`;
}

/** "2.4 MB", "530 KB", "12 bytes". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}
