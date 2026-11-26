/**
 * HEIC and HEIF photos (iPhones save them) decoded on this computer with libheif, built for the
 * web as WebAssembly by the libheif-js project: vendor/libheif-js/ holds its official 1.23.5
 * release files, unchanged (VENDOR.md at the add-on's root says where they come from). It is
 * loaded only when a HEIC photo has to be made smaller, so the add-on does not carry it in
 * memory otherwise. libheif turns the picture as the file says (its rotation and mirroring).
 */

let library = null;

/** The library, loaded and started once. */
async function load() {
  if (!library) {
    library = import('../vendor/libheif-js/libheif-wasm/libheif-bundle.mjs').then(
      async (module) => {
        const lib = module.default();
        await lib.ready;
        return lib;
      },
    );
    // A failed start may work next time (memory was short): forget it.
    library.catch(() => {
      library = null;
    });
  }
  return library;
}

/**
 * The first (primary) picture of a HEIC file as RGBA pixels.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray }>}
 */
export async function decodeHeic(bytes) {
  const lib = await load();
  const images = new lib.HeifDecoder().decode(bytes);
  try {
    const image = images[0];
    if (!image) throw new Error('No picture in this HEIC file.');
    const width = image.get_width();
    const height = image.get_height();
    const data = await new Promise((resolve, reject) => {
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (shown) =>
        shown ? resolve(shown.data) : reject(new Error('This HEIC file could not be decoded.')),
      );
    });
    return { width, height, data };
  } finally {
    for (const image of images) image.free();
  }
}
