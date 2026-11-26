import { formatBytes, formatOf } from './formats.js';

/**
 * "Fit attachments for sending": the plain rules. How big the attachments may be together, how a
 * budget is shared among them, what Converter Studio's server is asked for when the computer
 * cannot make a file smaller itself, and the words of the outcome. lib/fitter.js runs them
 * against Thunderbird and Converter Studio; lib/photos.js makes the photos smaller.
 */

/** A megabyte as Converter Studio counts size limits: 1,000,000 bytes, so a limit is always met. */
export const MB_BYTES = 1_000_000;
/**
 * Converter Studio's "Fit for email" size: `EMAIL_ATTACHMENT_MB` in packages/shared/src/options.ts,
 * copied because the add-on has no build step (test/fit.test.js compares the copy). A mail program
 * sends an attachment base64-encoded, about a third larger: 16 MB of attachments become about
 * 22 MB, which Gmail and Yahoo Mail (25 MB) take.
 */
export const EMAIL_ATTACHMENT_MB = 16;
/** The smaller target: about 14 MB once encoded, which Outlook.com and iCloud Mail (20 MB) take too. */
export const SMALL_TARGET_MB = 10;

/** The targets, as the compose popup offers them. */
export const FIT_TARGETS = [
  { mb: EMAIL_ATTACHMENT_MB, label: '16 MB: Gmail, Yahoo Mail' },
  { mb: SMALL_TARGET_MB, label: '10 MB: also Outlook.com, iCloud' },
];

/** A stored or picked target: 10, or else the default 16. */
export const normalizeTargetMb = (value) =>
  Number(value) === SMALL_TARGET_MB ? SMALL_TARGET_MB : EMAIL_ATTACHMENT_MB;

/** "31.2 MB", "850 KB": one decimal from a megabyte up, as the summary shows sizes. */
export function formatMb(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < MB_BYTES) return formatBytes(bytes);
  return `${(bytes / MB_BYTES).toFixed(1)} MB`;
}

/** "1 attachment", "4 attachments". */
export const attachments = (n) => `${n} attachment${n === 1 ? '' : 's'}`;

/** Which mail services take attachments that come to `bytes` together, or '' for none of these. */
export function whereItFits(bytes) {
  if (bytes <= SMALL_TARGET_MB * MB_BYTES)
    return 'Fits Gmail, Yahoo Mail, Outlook.com and iCloud Mail.';
  if (bytes <= EMAIL_ATTACHMENT_MB * MB_BYTES) return 'Fits Gmail and Yahoo Mail.';
  return '';
}

/**
 * The one-line outcome: "4 attachments, 31.2 MB → 14.8 MB. Fits Gmail and Yahoo Mail."
 * @param {{ count: number, before: number, after: number, targetMb: number }} totals
 */
export function summaryLine({ count, before, after, targetMb }) {
  const sizes = `${attachments(count)}, ${formatMb(before)} → ${formatMb(after)}.`;
  if (after <= targetMb * MB_BYTES) return `${sizes} ${whereItFits(after)}`;
  return [sizes, `Still over ${targetMb} MB.`, whereItFits(after)].filter(Boolean).join(' ');
}

/**
 * Each item's share of `budget`: items no larger than an even share keep their size, and what
 * is left is split evenly among the larger ones. The shares add up to at most `budget`; without
 * a budget every share is 0.
 * @param {number[]} sizes
 * @param {number} budget
 * @returns {number[]}
 */
export function shares(sizes, budget) {
  const out = sizes.map(() => 0);
  if (!(budget > 0)) return out;
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  let left = budget;
  for (let k = 0; k < order.length; k++) {
    const even = left / (order.length - k);
    if (sizes[order[k]] <= even) {
      out[order[k]] = sizes[order[k]];
      left -= sizes[order[k]];
    } else {
      for (const i of order.slice(k)) out[i] = Math.floor(even);
      break;
    }
  }
  return out;
}

/**
 * The largest attachments, enough of them to make up what is over the target: the ones to name
 * when it does not fit.
 * @template {{ size: number }} T
 * @param {T[]} items
 * @param {number} target
 * @returns {T[]}
 */
export function largestOver(items, target) {
  let over = items.reduce((sum, item) => sum + item.size, 0) - target;
  const named = [];
  for (const item of [...items].sort((a, b) => b.size - a.size)) {
    if (over <= 0) break;
    named.push(item);
    over -= item.size;
  }
  return named;
}

/** Pictures the server should not turn into a JPG: animations, icons and drawings. */
const NOT_PHOTOS = new Set(['gif', 'ico', 'svg', 'eps', 'ai']);

/**
 * What Converter Studio's server is asked for to make an attachment smaller within `share` bytes,
 * or `null` when it cannot (a Word file, an archive, a format it does not read). Only options
 * packages/shared/src/options.ts allows for that target:
 * - a PDF: compressed (`emailFit`: harder only when it has to, up to the 16 MB of "Fit for email");
 * - a video: an MP4 with `emailFit`, and a size limit (`maxSize`) when the share is smaller than
 *   that. An MP4 stays an MP4: the server makes it smaller in its own format (its `compress` in
 *   the format list, from 2026-11-26); only a server that does not list that turns it into a MOV
 *   with the same H.264 video, as before;
 * - a sound: an MP3 with `emailFit` (an MP3 stays an MP3 the same way; an M4A from a server
 *   without `compress`);
 * - a photo the computer cannot read: a JPG with `emailFit` and `maxKb`.
 * @param {import('./formats.js').Catalog} catalog
 * @param {string} name
 * @param {number} share
 * @returns {{ from: string, to: string, options: object } | null}
 */
export function serverFit(catalog, name, share) {
  const from = formatOf(catalog, name);
  const format = from ? catalog.byId.get(from) : undefined;
  if (!format) return null;
  let to;
  const options = { emailFit: true };
  if (from === 'pdf') {
    to = 'pdf';
    options.compression = 'balanced';
  } else if (format.category === 'video') {
    to = from === 'mp4' && !format.compress ? 'mov' : 'mp4';
    if (to === 'mp4' && share < EMAIL_ATTACHMENT_MB * MB_BYTES)
      options.maxSize = Math.max(1, Math.floor(share / MB_BYTES));
  } else if (format.category === 'audio') {
    to = from === 'mp3' && !format.compress ? 'm4a' : 'mp3';
  } else if (format.category === 'image' && !NOT_PHOTOS.has(from)) {
    to = 'jpg';
    options.maxKb = Math.min(100_000, Math.max(5, Math.floor(share / 1000)));
  } else {
    return null;
  }
  // Its own format where the server makes that format smaller (`compress`; MP4 and MP3 are only
  // there, PDF and JPG in `to` as well).
  const offered = format.to.includes(to) || (to === from && format.compress);
  return offered ? { from, to, options } : null;
}

/**
 * `name` with the extension of the type it now has: kept when it already is one of the type's
 * (`IMG.JPEG` stays), replaced otherwise (`IMG_1.HEIC` → `IMG_1.jpg`), added when there is none.
 * @param {string} name
 * @param {string[]} extensions the new type's extensions, its usual one first
 */
export function renamed(name, extensions) {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (extensions.includes(extension)) return name;
  return `${dot > 0 ? name.slice(0, dot) : name}.${extensions[0]}`;
}
