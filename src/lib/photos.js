import { renamed } from './fit.js';

/**
 * Photos made smaller on this computer, for "Fit attachments for sending": free, with no account
 * and nothing sent anywhere. A photo is resized (the long side at most 2048 px; 1600, then 1280
 * only while it is still over its share) and saved again, a JPEG or WebP at the highest quality
 * that keeps it within its share. The picture is turned as the camera meant (EXIF orientation),
 * and its metadata (EXIF: date, camera, location) does not go into the new file.
 *
 * A PNG without transparency may become a JPG; one with transparency stays a PNG, only resized.
 * A HEIC photo becomes a JPG (decoded with libheif, lib/heic.js).
 *
 * The pixels are drawn by a backend (lib/canvas.js in Thunderbird, a fake in the tests):
 *   decode(file, kind) → image ({ width, height }), the right way up
 *   transparent(image) → whether any pixel is see-through
 *   resize(image, width, height, background) → a canvas of that size ('#ffffff' fills behind)
 *   encode(canvas, type, quality) → Blob of that type, or throws when it cannot make the type
 *   release(imageOrCanvas)
 */

/** Long sides tried in turn, largest first; never larger than the photo itself. */
export const LONG_SIDES = [2048, 1600, 1280];
/** The quality a photo is saved with first, and the lowest the search goes to. */
export const QUALITY = Object.freeze({ start: 0.85, lowest: 0.5 });

/** What each kind is saved as, and the extensions that mean it (its usual one first). */
const TYPES = {
  jpeg: { type: 'image/jpeg', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'] },
  png: { type: 'image/png', extensions: ['png'] },
  webp: { type: 'image/webp', extensions: ['webp'] },
};

/** HEIF brands of HEVC-coded pictures (an AVIF has its own brand and is left alone). */
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

/**
 * The kind of photo a file's first bytes show (its name does not count), or `null` for anything
 * this computer does not make smaller itself.
 * @param {Uint8Array} bytes at least the first 32 bytes
 * @returns {'jpeg' | 'png' | 'webp' | 'heic' | null}
 */
export function sniff(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    // The major brand, then the compatible ones (an iPhone's: "heic", "mif1", "heic").
    const length = Math.min(
      bytes.length,
      new DataView(bytes.buffer, bytes.byteOffset).getUint32(0),
    );
    const brands = [ascii(bytes, 8, 12)];
    for (let at = 16; at + 4 <= length; at += 4) brands.push(ascii(bytes, at, at + 4));
    if (brands.some((brand) => HEIF_BRANDS.has(brand))) return 'heic';
  }
  return null;
}

/**
 * The size a picture is drawn at so that its longer side is at most `longSide` (never enlarged).
 * @returns {{ width: number, height: number }}
 */
export function fitDimensions(width, height, longSide) {
  const scale = Math.min(1, longSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The long sides to try for a picture: its own (up to 2048), then the smaller steps. */
export function longSidesFor(width, height) {
  const own = Math.min(Math.max(width, height), LONG_SIDES[0]);
  return [own, ...LONG_SIDES.filter((side) => side < own)];
}

/**
 * The highest quality from `lowest` to `start` whose file is at most `limit` bytes, by halving
 * the range a few times; `fits: false` with the smallest file when not even `lowest` is.
 * @param {(quality: number) => Promise<Blob>} encodeAt
 * @param {number} limit
 * @returns {Promise<{ blob: Blob, fits: boolean }>}
 */
export async function searchQuality(encodeAt, limit, { start, lowest } = QUALITY, rounds = 4) {
  const first = await encodeAt(start);
  if (first.size <= limit) return { blob: first, fits: true };
  const last = await encodeAt(lowest);
  if (last.size > limit) return { blob: last, fits: false };
  let low = lowest;
  let high = start;
  let best = last;
  for (let round = 0; round < rounds; round++) {
    const quality = Math.round(((low + high) / 2) * 100) / 100;
    if (quality <= low || quality >= high) break;
    const blob = await encodeAt(quality);
    if (blob.size <= limit) {
      best = blob;
      low = quality;
    } else {
      high = quality;
    }
  }
  return { blob: best, fits: true };
}

/**
 * A photo read for making smaller: decoded once the right way up, with whether it is opaque.
 * @param {File} file
 * @param {'jpeg' | 'png' | 'webp' | 'heic'} kind
 */
export async function readPhoto(file, kind, backend) {
  const image = await backend.decode(file, kind);
  try {
    const opaque = kind === 'png' ? !(await backend.transparent(image)) : kind !== 'webp';
    return { kind, image, width: image.width, height: image.height, opaque };
  } catch (error) {
    backend.release(image);
    throw error;
  }
}

/**
 * What a photo is saved as: a HEIC as a JPG; a PNG as a PNG, or, when it has no transparency
 * and must get smaller than resizing alone makes it, as a JPG; a JPEG and a WebP as themselves.
 */
function outputOf(photo, fitting) {
  if (photo.kind === 'heic') return TYPES.jpeg;
  if (photo.kind === 'png') return fitting && photo.opaque ? TYPES.jpeg : TYPES.png;
  return TYPES[photo.kind];
}

/**
 * A smaller copy of a photo, or `null` when none is smaller than `size` (the attachment's size
 * now). Without a share it is the first step every photo gets: the long side at most 2048 px and
 * quality 0.85. With a share, each long side in turn (2048, 1600, 1280) gets a quality search
 * towards the share, and the first that fits wins; when none does, the smallest made.
 * @param {{ kind: string, image: object, width: number, height: number, opaque: boolean }} photo
 * @param {{ name: string, size: number, share?: number | null }} target
 * @returns {Promise<{ blob: Blob, name: string, type: string } | null>}
 */
export async function shrinkPhoto(photo, { name, size, share = null }, backend) {
  const fitting = share !== null;
  const output = outputOf(photo, fitting);
  const lossy = output.type !== 'image/png';
  const sides = longSidesFor(photo.width, photo.height);
  let best = null;
  for (const side of fitting ? sides : sides.slice(0, 1)) {
    const { width, height } = fitDimensions(photo.width, photo.height, side);
    const canvas = await backend.resize(photo.image, width, height, lossy ? '#ffffff' : null);
    try {
      let blob;
      let fits;
      if (!lossy) {
        blob = await backend.encode(canvas, output.type);
        fits = !fitting || blob.size <= share;
      } else if (!fitting) {
        blob = await backend.encode(canvas, output.type, QUALITY.start);
        fits = true;
      } else {
        ({ blob, fits } = await searchQuality(
          (quality) => backend.encode(canvas, output.type, quality),
          share,
        ));
      }
      if (fits) {
        best = blob;
        break;
      }
      if (!best || blob.size < best.size) best = blob;
    } finally {
      backend.release(canvas);
    }
  }
  if (!best || best.size >= size) return null;
  return { blob: best, type: output.type, name: renamed(name, output.extensions) };
}
