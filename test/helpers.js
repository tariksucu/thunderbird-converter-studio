/**
 * Test helpers: a fake Converter Studio API (a `fetch` that answers like the real one) and a
 * catalogue taken from the real `GET /v1/formats` answer (trimmed to the formats the tests use).
 */

export const BASE = 'https://converter.studio/api';

/**
 * A trimmed copy of the API's `GET /v1/formats` answer (2026-11-23; `compress` as the API lists it
 * from 2026-11-26).
 */
export const FORMATS_BODY = {
  formats: [
    {
      id: 'heic',
      name: 'HEIC',
      category: 'image',
      extensions: ['heic', 'heif'],
      to: ['jpg', 'pdf', 'png', 'webp'],
    },
    {
      id: 'jpg',
      name: 'JPG',
      category: 'image',
      extensions: ['jpg', 'jpeg', 'jpe', 'jfif'],
      to: ['pdf', 'png', 'webp'],
      compress: true,
    },
    {
      id: 'png',
      name: 'PNG',
      category: 'image',
      extensions: ['png'],
      to: ['jpg', 'pdf', 'webp'],
      compress: true,
    },
    {
      id: 'webp',
      name: 'WebP',
      category: 'image',
      extensions: ['webp'],
      to: ['jpg', 'png'],
      compress: true,
    },
    {
      id: 'docx',
      name: 'DOCX',
      category: 'document',
      extensions: ['docx'],
      to: ['pdf', 'odt', 'txt'],
    },
    {
      id: 'pdf',
      name: 'PDF',
      category: 'document',
      extensions: ['pdf'],
      to: ['jpg', 'pdf', 'docx', 'png'],
      compress: true,
    },
    {
      id: 'mov',
      name: 'MOV',
      category: 'video',
      extensions: ['mov', 'qt'],
      to: ['mp4', 'mp3', 'webm'],
    },
    {
      id: 'mp4',
      name: 'MP4',
      category: 'video',
      extensions: ['mp4', 'm4v'],
      to: ['mp3', 'webm', 'mov'],
      compress: true,
    },
    { id: 'tgz', name: 'TAR.GZ', category: 'archive', extensions: ['tar.gz', 'tgz'], to: ['zip'] },
    { id: 'gz', name: 'GZ', category: 'archive', extensions: ['gz'], to: ['zip'] },
    { id: 'zip', name: 'ZIP', category: 'archive', extensions: ['zip'], to: ['7z'] },
    { id: 'odt', name: 'ODT', category: 'document', extensions: ['odt'], to: ['pdf'] },
    { id: 'txt', name: 'TXT', category: 'document', extensions: ['txt'], to: ['pdf'] },
  ],
};

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * A fake API on `BASE`. `routes` overrides answers by "METHOD path" (path without the base, the
 * last segment may be `:id`): a Response, a function returning one, `{ status, body }`, or a JSON
 * body. Every request is recorded with its headers and body.
 */
export function fakeApi(routes = {}) {
  const requests = [];
  let conversions = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const pathname = u.pathname.replace(/^\/api/, '');
    const key = `${init.method ?? 'GET'} ${pathname}`;
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let body = init.body;
    if (typeof body === 'string') body = JSON.parse(body);
    else if (body && typeof body.arrayBuffer === 'function')
      body = { bytes: (await body.arrayBuffer()).byteLength };
    requests.push({ key, url: String(url), search: u.search, headers, body, init });
    const route =
      routes[key] ?? routes[`${init.method ?? 'GET'} ${pathname.replace(/\/[^/]+$/, '/:id')}`];
    if (typeof route === 'function') return route({ url: u, headers, body, requests });
    // `{ status, body }` sets the status; any other object is a 200 answer's body.
    if (route instanceof Response) return route;
    if (route)
      return 'body' in route ? json(route.status, route.body, route.headers) : json(200, route);
    // Defaults: the happy path.
    if (key === 'GET /v1/formats') return json(200, FORMATS_BODY);
    if (key === 'GET /v1/account') return json(200, { plan: 'pro', credits: 99, allowance: null });
    if (key === 'POST /v1/uploads')
      return json(201, {
        id: 'up_12345678',
        uploadUrl: `${BASE}/v1/uploads/up_12345678?token=t`,
        partBytes: 95 * 1024 * 1024,
      });
    if (key.startsWith('PUT /v1/uploads/'))
      return json(200, {
        id: 'up_12345678',
        status: 'ready',
        file: { name: 'x', size: body.bytes, format: 'heic' },
      });
    if (key === 'POST /v1/conversions') {
      conversions += 1;
      return json(201, {
        id: 'up_12345678',
        status: 'queued',
        maxCredits: body.maxCredits,
        credits: 1,
      });
    }
    if (key.startsWith('GET /v1/conversions/'))
      return json(200, {
        id: 'up_12345678',
        status: 'done',
        credits: 1,
        outputName: 'IMG_0001.jpg',
        downloadUrl: `${BASE}/jobs/up_12345678/download?token=d`,
      });
    if (key.startsWith('GET /jobs/'))
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    return json(404, { error: { code: 'notFound', message: 'No such route.' } });
  };
  return {
    fetch,
    requests,
    get conversions() {
      return conversions;
    },
  };
}

export { json };

/** A client options object that never waits. */
export const fast = { sleep: async () => {}, version: '1.0.0', newKey: () => 'key-1' };
