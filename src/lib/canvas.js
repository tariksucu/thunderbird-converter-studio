/* global createImageBitmap, OffscreenCanvas, ImageData */
import { decodeHeic } from './heic.js';

/**
 * The pixels of lib/photos.js, drawn with Thunderbird's own image decoders and canvas in the
 * background page: nothing leaves the computer. JPEG, PNG and WebP are decoded by Thunderbird
 * (turned as their EXIF orientation says), HEIC by libheif (lib/heic.js).
 */

/** Alpha is checked on a copy at most this large (a see-through pixel still shows there). */
const ALPHA_CHECK_SIDE = 1024;

function context(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

export const canvasBackend = {
  /** The photo as an ImageBitmap, the right way up. */
  async decode(file, kind) {
    if (kind === 'heic') {
      const { width, height, data } = await decodeHeic(new Uint8Array(await file.arrayBuffer()));
      return createImageBitmap(new ImageData(data, width, height));
    }
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  },

  /** Whether any pixel is (even partly) see-through. */
  async transparent(image) {
    const scale = Math.min(1, ALPHA_CHECK_SIDE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = context(canvas);
    ctx.drawImage(image, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
  },

  /**
   * The picture at `width` × `height`, halved step by step first (a single large step loses
   * detail), over `background` when one is given (a JPEG has no transparency).
   */
  async resize(image, width, height, background) {
    let source = image;
    let w = image.width;
    let h = image.height;
    while (w >= width * 2 && h >= height * 2) {
      w = Math.round(w / 2);
      h = Math.round(h / 2);
      const half = new OffscreenCanvas(w, h);
      context(half).drawImage(source, 0, 0, w, h);
      if (source !== image) this.release(source);
      source = half;
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = context(canvas);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(source, 0, 0, width, height);
    if (source !== image) this.release(source);
    return canvas;
  },

  /** The canvas saved as `type`; Thunderbird makes a PNG instead of a type it cannot write. */
  async encode(canvas, type, quality) {
    const blob = await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
    if (blob.type !== type) throw new Error(`This Thunderbird cannot save ${type}.`);
    return blob;
  },

  release(item) {
    if (typeof item?.close === 'function') item.close();
    else if (item && 'width' in item) {
      // An OffscreenCanvas: no pixels kept once it has no size.
      item.width = 0;
      item.height = 0;
    }
  },
};
