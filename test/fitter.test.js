import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConverterStudioClient } from '../src/lib/client.js';
import { renamed } from '../src/lib/fit.js';
import { FILELINK_HINT, Fitter } from '../src/lib/fitter.js';
import { parseCatalog } from '../src/lib/formats.js';
import { BASE, FORMATS_BODY, fakeApi, fast, json } from './helpers.js';

const MB = 1_000_000;
const HEADS = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  png: [...'\x89PNG\r\n\x1a\n'].map((c) => c.charCodeAt(0)),
  heic: [0, 0, 0, 24, ...[...'ftypheic\0\0\0\0mif1heic'].map((c) => c.charCodeAt(0))],
  pdf: [...'%PDF-1.7'].map((c) => c.charCodeAt(0)),
  none: [],
};

/**
 * An attachment's file. A photo is a stand-in that only knows its first bytes and how far the
 * fake photo code below can shrink it (`standard`: its first step; `floor`: the smallest it
 * gets); anything else is a real file of that many bytes (it may be uploaded).
 */
function attachment(name, size, kind = 'none', { standard, floor = 0.3 * MB, real = false } = {}) {
  const head = new Uint8Array(64);
  head.set(HEADS[kind]);
  if (!real && (kind === 'jpeg' || kind === 'png' || kind === 'heic')) {
    const file = {
      name,
      size,
      standard: standard ?? Math.min(size, 1.3 * MB),
      floor,
      slice: (from, to) => new Blob([head.subarray(from, to)]),
    };
    return { name, size, file };
  }
  const bytes = new Uint8Array(size);
  bytes.set(head.subarray(0, Math.min(64, size)));
  return { name, size, file: new File([bytes], name) };
}

/** A compose window holding `list`, as Thunderbird's compose API shows it. */
function fakeCompose(list) {
  const attachments = list.map((a, i) => ({ id: i + 1, ...a }));
  const state = { open: true, updates: [], reads: 0 };
  return {
    attachments,
    state,
    async listAttachments() {
      if (!state.open) throw new Error('Invalid tab ID: 7');
      return attachments.map(({ id, name, size }) => ({ id, name, size }));
    },
    async getAttachmentFile(id) {
      state.reads++;
      const found = attachments.find((a) => a.id === id);
      if (!found) throw new Error(`Invalid attachment: ${id}`);
      return found.file;
    },
    async updateAttachment(tabId, id, { file, name }) {
      if (!state.open) throw new Error('Invalid tab ID');
      state.updates.push({ id, name, size: file.size, type: file.type });
      Object.assign(
        attachments.find((a) => a.id === id),
        { file, name, size: file.size },
      );
    },
  };
}

/** The photo code, faked: the first step gives `standard` bytes, a share at most down to `floor`. */
function fakePhotos({ unreadable = [] } = {}) {
  const calls = [];
  return {
    calls,
    async read(file, kind) {
      if (unreadable.includes(file.name)) throw new Error('cannot decode');
      return { file, kind };
    },
    async shrink(photo, { name, size, share }) {
      calls.push({ name, share });
      const bytes =
        share === null
          ? photo.file.standard
          : Math.max(Math.min(share, photo.file.standard), photo.file.floor);
      if (bytes >= size) return null;
      const jpeg = photo.kind !== 'png';
      return {
        blob: new Blob([new Uint8Array(Math.round(bytes))], {
          type: jpeg ? 'image/jpeg' : 'image/png',
        }),
        type: jpeg ? 'image/jpeg' : 'image/png',
        name: jpeg ? renamed(name, ['jpg', 'jpeg']) : name,
      };
    },
    release() {},
  };
}

const CATALOG = parseCatalog({
  formats: [
    ...FORMATS_BODY.formats,
    {
      id: 'mp3',
      name: 'MP3',
      category: 'audio',
      extensions: ['mp3'],
      to: ['m4a', 'wav'],
      compress: true,
    },
  ],
});
const PRICES = { pdf: 1, mp4: 4, mp3: 2, jpg: 1 };

/**
 * A fake API that prices every conversion (`maxCredits: 0` waits), converts on confirm and sends
 * back a file of `resultBytes` (or what `results` says for an upload's name). The uploads named
 * in `notSmaller` come back as they were (`notSmaller: true`, nothing charged).
 */
function pricingApi({ results = {}, failConfirm = {}, notSmaller = [], routes = {} } = {}) {
  let uploads = 0;
  const names = new Map();
  const confirmed = [];
  const started = [];
  const downloads = [];
  const api = fakeApi({
    'POST /v1/uploads': ({ body }) => {
      const id = `up_0000000${++uploads}`;
      names.set(id, body.fileName);
      return json(201, { id, uploadUrl: `${BASE}/v1/uploads/${id}?token=t`, partBytes: 95 * MB });
    },
    'POST /v1/conversions': ({ body }) => {
      started.push(body);
      return json(201, {
        id: body.uploadId,
        status: body.maxCredits === 0 ? 'quoted' : 'queued',
        credits: PRICES[body.to] ?? 1,
        maxCredits: body.maxCredits,
      });
    },
    'GET /v1/conversions/:id': ({ url }) => {
      const id = url.pathname.split('/').at(-1);
      const name = names.get(id);
      if (failConfirm[name]) return json(200, { id, status: 'failed', error: failConfirm[name] });
      const kept = notSmaller.includes(name);
      return json(200, {
        id,
        status: 'done',
        credits: kept ? 0 : 1,
        notSmaller: kept,
        downloadUrl: `${BASE}/jobs/${id}/download?token=d`,
      });
    },
    ...routes,
  });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const confirm = /\/v1\/conversions\/([^/]+)\/confirm$/.exec(u.pathname);
    if (confirm) {
      confirmed.push(names.get(confirm[1]));
      api.requests.push({ key: `POST confirm ${confirm[1]}` });
      return json(200, { id: confirm[1], status: 'queued', credits: 1 });
    }
    const download = /\/jobs\/([^/]+)\/download$/.exec(u.pathname);
    if (download) {
      const name = names.get(download[1]);
      downloads.push(name);
      return new Response(new Uint8Array(results[name] ?? 1000), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    return api.fetch(url, init);
  };
  return { ...api, fetch, confirmed, started, downloads };
}

function setup({ list, apiKey = 'cvs_live_k', api = pricingApi(), photos = fakePhotos() }) {
  const compose = fakeCompose(list);
  const changes = [];
  const fitter = new Fitter({
    compose,
    photos,
    settings: async () => ({ apiKey, baseUrl: BASE }),
    client: (s) => new ConverterStudioClient({ ...s, fetch: api.fetch, ...fast }),
    catalog: async () => CATALOG,
    onChange: (fit) => changes.push(fit),
  });
  return { fitter, compose, changes, api, photos };
}

/** Runs a fit; `onQuote` answers the price when one is asked. */
async function fit(env, targetMb = 16, onQuote = null) {
  const done = env.fitter.start({ tabId: 7, targetMb });
  if (onQuote) {
    for (let i = 0; i < 200 && env.fitter.get(7)?.state !== 'quoted'; i++)
      await new Promise((r) => setTimeout(r, 5));
    const quoted = env.fitter.get(7);
    assert.equal(quoted?.state, 'quoted', quoted?.text);
    onQuote(quoted);
  }
  return done;
}

const names = (compose) => compose.attachments.map((a) => a.name);
const uploads = (api) => api.requests.filter((r) => r.key === 'POST /v1/uploads').length;

describe('a draft that already fits', () => {
  it('changes nothing and says so', async () => {
    const env = setup({
      list: [attachment('IMG_1.jpg', 2 * MB, 'jpeg'), attachment('notes.txt', MB)],
    });
    const result = await fit(env);
    assert.equal(result.state, 'done');
    assert.equal(result.fits, true);
    assert.equal(
      result.text,
      'Already fits: 2 attachments, 3.0 MB. Fits Gmail, Yahoo Mail, Outlook.com and iCloud Mail.',
    );
    assert.equal(env.compose.state.updates.length, 0);
    assert.equal(env.compose.state.reads, 0);
    assert.equal(env.api.requests.length, 0);
  });

  it('with no attachments, says to attach some', async () => {
    const result = await fit(setup({ list: [] }));
    assert.equal(result.text, 'Attach files to this message first.');
  });
});

describe('photos, on this computer', () => {
  it('the largest first, only until it fits; no key and nothing sent', async () => {
    const env = setup({
      apiKey: '',
      list: [
        attachment('small.jpg', 0.5 * MB, 'jpeg'),
        attachment('IMG_2.HEIC', 5 * MB, 'heic'),
        attachment('IMG_1.jpg', 7 * MB, 'jpeg'),
        attachment('report.docx', 4 * MB),
      ],
    });
    const result = await fit(env);
    // 16.5 MB: IMG_1.jpg (7 → 1.3 MB) is enough; the HEIC and the small photo stay as they are.
    assert.equal(result.state, 'done', result.text);
    assert.equal(result.text, '4 attachments, 16.5 MB → 10.8 MB. Fits Gmail and Yahoo Mail.');
    assert.deepEqual(names(env.compose), ['small.jpg', 'IMG_2.HEIC', 'IMG_1.jpg', 'report.docx']);
    assert.deepEqual(env.compose.state.updates, [
      { id: 3, name: 'IMG_1.jpg', size: 1.3 * MB, type: 'image/jpeg' },
    ]);
    assert.equal(env.api.requests.length, 0);
    assert.ok(
      env.changes.some((c) => /^Making photos smaller on this computer… 1 of 3$/.test(c.text)),
    );
  });

  it('a HEIC becomes a JPG in its place', async () => {
    const env = setup({
      list: [
        attachment('a.txt', 100),
        attachment('IMG_0001.HEIC', 17 * MB, 'heic', { standard: 2 * MB }),
      ],
    });
    const result = await fit(env);
    assert.equal(result.fits, true);
    assert.deepEqual(names(env.compose), ['a.txt', 'IMG_0001.jpg']);
  });

  it('smaller steps toward each share when the first is not enough', async () => {
    const env = setup({
      list: [
        attachment('scan.png', 8 * MB, 'png', { standard: 4 * MB, floor: 0.5 * MB }),
        attachment('IMG_1.jpg', 6 * MB, 'jpeg', { standard: 3 * MB }),
        attachment('contract.docx', 4 * MB),
      ],
    });
    const result = await fit(env, 10);
    // First step: 4 + 3 + 4 = 11 MB; the photos then share the 6 MB the document leaves.
    assert.equal(result.fits, true, result.text);
    assert.deepEqual(
      env.photos.calls.map((c) => [c.name, c.share]),
      [
        ['scan.png', null],
        ['IMG_1.jpg', null],
        ['scan.png', 3 * MB],
      ],
    );
    assert.equal(
      result.text,
      '3 attachments, 18.0 MB → 10.0 MB. Fits Gmail, Yahoo Mail, Outlook.com and iCloud Mail.',
    );
  });

  it('no smaller steps when even the smallest photos could not make it fit', async () => {
    const env = setup({
      apiKey: '',
      list: [attachment('IMG_1.jpg', 6 * MB, 'jpeg'), attachment('report.pdf', 15.9 * MB, 'pdf')],
    });
    // After the first step 1.3 + 15.9 MB: the photo could not get under the 0.1 MB left.
    await fit(env);
    assert.deepEqual(
      env.photos.calls.map((c) => c.share),
      [null],
    );
    // With a little more room, the photo takes the smaller steps and it fits, free.
    const roomy = setup({
      apiKey: '',
      list: [attachment('IMG_1.jpg', 6 * MB, 'jpeg'), attachment('report.pdf', 15 * MB, 'pdf')],
    });
    const result = await fit(roomy);
    assert.deepEqual(
      roomy.photos.calls.map((c) => c.share),
      [null, 1 * MB],
    );
    assert.equal(result.fits, true, result.text);
  });

  it('a photo this computer cannot read goes to the server as a JPG', async () => {
    const env = setup({
      list: [attachment('IMG_9.HEIC', 20 * MB, 'heic', { real: true })],
      photos: fakePhotos({ unreadable: ['IMG_9.HEIC'] }),
    });
    const result = await fit(env, 16, (quoted) => env.fitter.answer(quoted.tabId, true));
    assert.equal(result.fits, true, result.text);
    assert.equal(env.api.started[0].to, 'jpg');
    assert.deepEqual(env.api.started[0].options, { emailFit: true, maxKb: 16_000 });
    assert.deepEqual(names(env.compose), ['IMG_9.jpg']);
  });
});

describe('what needs the server', () => {
  const draft = () => [
    attachment('IMG_1.jpg', 6 * MB, 'jpeg'),
    attachment('report.pdf', 18 * MB, 'pdf'),
    attachment('clip.mov', 20 * MB),
    attachment('notes.txt', 200),
  ];

  it('without a key: the photos still get smaller, the rest is named with what a key does', async () => {
    const env = setup({ apiKey: '', list: draft() });
    const result = await fit(env);
    assert.equal(result.state, 'done');
    assert.equal(result.fits, false);
    assert.deepEqual(
      env.compose.state.updates.map((u) => u.name),
      ['IMG_1.jpg'],
    );
    assert.equal(uploads(env.api), 0);
    assert.equal(
      result.keyLine,
      "report.pdf and clip.mov need Converter Studio's server: with an API key, they are made " +
        'smaller there, and you see the price first.',
    );
    assert.deepEqual(result.lines, [
      `Too big to fit: clip.mov (20.0 MB), report.pdf (18.0 MB). ${FILELINK_HINT}`,
    ]);
    assert.match(result.text, /^4 attachments, 44\.0 MB → 39\.3 MB\. Still over 16 MB\.$/);
  });

  it('with a key: the price first, then each attachment replaced in its place', async () => {
    const env = setup({ list: draft() });
    let quote;
    const result = await fit(env, 16, (quoted) => {
      quote = quoted;
      // Nothing was converted before the go-ahead.
      assert.equal(env.api.confirmed.length, 0);
      assert.equal(env.compose.state.updates.length, 1);
      env.fitter.answer(quoted.tabId, true);
    });
    assert.equal(quote.credits, 5);
    assert.equal(
      quote.text,
      'Converter Studio can make report.pdf and clip.mov → clip.mp4 smaller for 5 credits.',
    );
    // Priced only: maxCredits 0, the options "Fit for email" allows for each target.
    assert.deepEqual(
      env.api.started.map((s) => [s.to, s.maxCredits, s.options]),
      [
        ['pdf', 0, { emailFit: true, compression: 'balanced' }],
        ['mp4', 0, { emailFit: true, maxSize: 7 }],
      ],
    );
    assert.deepEqual(env.api.confirmed, ['report.pdf', 'clip.mov']);
    assert.deepEqual(names(env.compose), ['IMG_1.jpg', 'report.pdf', 'clip.mp4', 'notes.txt']);
    assert.equal(result.fits, true, result.text);
    assert.match(result.text, /^4 attachments, 44\.0 MB → 1\.3 MB\. Fits Gmail, Yahoo Mail/);
    assert.deepEqual(result.lines, []);
  });

  it('Cancel: nothing converted or charged, the attachments as they were', async () => {
    const env = setup({ list: draft() });
    const result = await fit(env, 16, (quoted) => env.fitter.answer(quoted.tabId, false));
    assert.equal(env.api.confirmed.length, 0);
    assert.deepEqual(names(env.compose), ['IMG_1.jpg', 'report.pdf', 'clip.mov', 'notes.txt']);
    assert.equal(env.compose.attachments[1].size, 18 * MB);
    assert.equal(result.fits, false);
    assert.equal(
      result.lines[0],
      'Not sent for conversion, so nothing was charged: report.pdf and clip.mov.',
    );
    assert.match(result.lines.at(-1), /^Too big to fit: clip\.mov \(20\.0 MB\)/);
  });

  it('one that fails stays as it was; the others are replaced', async () => {
    const api = pricingApi({
      failConfirm: {
        'clip.mov': {
          code: 'emailTooLong',
          message: 'Too long for an email, even at the lowest quality.',
        },
      },
    });
    const env = setup({ list: draft(), api });
    const result = await fit(env, 16, (quoted) => env.fitter.answer(quoted.tabId, true));
    assert.deepEqual(names(env.compose), ['IMG_1.jpg', 'report.pdf', 'clip.mov', 'notes.txt']);
    assert.equal(env.compose.attachments[1].size, 1000);
    assert.equal(env.compose.attachments[2].size, 20 * MB);
    assert.equal(result.lines[0], 'clip.mov: Too long for an email, even at the lowest quality.');
    assert.equal(result.fits, false);
  });

  it('a result that is not smaller is not used', async () => {
    const api = pricingApi({ results: { 'report.pdf': 18 * MB + 1 } });
    const env = setup({ list: [attachment('report.pdf', 18 * MB, 'pdf')], api });
    const result = await fit(env, 16, (quoted) => env.fitter.answer(quoted.tabId, true));
    assert.equal(env.compose.state.updates.length, 0);
    assert.equal(result.lines[0], 'report.pdf did not get smaller, so it was kept.');
  });

  it('an MP4 stays an MP4 and an MP3 an MP3, smaller, with the same names', async () => {
    const env = setup({
      list: [attachment('clip.mp4', 20 * MB), attachment('song.mp3', 10 * MB)],
    });
    let quote;
    const result = await fit(env, 16, (quoted) => {
      quote = quoted;
      env.fitter.answer(quoted.tabId, true);
    });
    assert.equal(
      quote.text,
      'Converter Studio can make clip.mp4 and song.mp3 smaller for 6 credits.',
    );
    // Each in its own format, within its share of the 16 MB: 8 MB each.
    assert.deepEqual(
      env.api.started.map((s) => [s.to, s.options]),
      [
        ['mp4', { emailFit: true, maxSize: 8 }],
        ['mp3', { emailFit: true }],
      ],
    );
    assert.deepEqual(names(env.compose), ['clip.mp4', 'song.mp3']);
    assert.deepEqual(
      env.compose.state.updates.map((u) => [u.name, u.size]),
      [
        ['clip.mp4', 1000],
        ['song.mp3', 1000],
      ],
    );
    assert.equal(result.fits, true, result.text);
    assert.deepEqual(result.lines, []);
  });

  it('one the server could not make smaller stays as it was, free, and is no failure', async () => {
    const api = pricingApi({ notSmaller: ['song.mp3'] });
    const env = setup({
      list: [attachment('clip.mp4', 20 * MB), attachment('song.mp3', 12 * MB)],
      api,
    });
    const result = await fit(env, 16, (quoted) => env.fitter.answer(quoted.tabId, true));
    assert.deepEqual(env.api.confirmed, ['clip.mp4', 'song.mp3']);
    // Not downloaded: the attachment itself is the result.
    assert.deepEqual(api.downloads, ['clip.mp4']);
    assert.deepEqual(names(env.compose), ['clip.mp4', 'song.mp3']);
    assert.equal(env.compose.attachments[1].size, 12 * MB);
    assert.deepEqual(
      env.compose.state.updates.map((u) => u.name),
      ['clip.mp4'],
    );
    // Said in the outcome's line; no failure below it.
    assert.equal(
      result.text,
      '2 attachments, 32.0 MB → 12.0 MB. Fits Gmail and Yahoo Mail. ' +
        'Already as small as it gets, so kept as it was (nothing charged): song.mp3.',
    );
    assert.deepEqual(result.lines, []);
    assert.equal(result.fits, true);
  });

  it('the kept line names them all', async () => {
    const api = pricingApi({ notSmaller: ['clip.mp4', 'song.mp3'] });
    const env = setup({
      list: [attachment('clip.mp4', 20 * MB), attachment('song.mp3', 12 * MB)],
      api,
    });
    const result = await fit(env, 16, (quoted) => env.fitter.answer(quoted.tabId, true));
    assert.equal(env.compose.state.updates.length, 0);
    assert.deepEqual(api.downloads, []);
    assert.match(
      result.text,
      / Still over 16 MB\. Already as small as they get, so kept as they were \(nothing charged\): clip\.mp4 and song\.mp3\.$/,
    );
    assert.equal(result.fits, false);
  });

  it('a wrong key: said once, nothing else sent', async () => {
    const api = pricingApi({
      routes: {
        'POST /v1/uploads': {
          status: 401,
          body: { error: { code: 'invalidApiKey', message: 'This API key does not work.' } },
        },
      },
    });
    const env = setup({ list: draft(), api });
    const result = await fit(env);
    assert.equal(uploads(api), 1);
    assert.equal(result.lines[0], 'report.pdf: This API key does not work.');
    assert.equal(result.fits, false);
  });

  it('nothing is sent when what cannot be made smaller is over the target by itself', async () => {
    const env = setup({
      list: [attachment('backup.zip', 17 * MB), attachment('report.pdf', 5 * MB, 'pdf')],
    });
    const result = await fit(env);
    assert.equal(env.api.requests.length, 0);
    assert.deepEqual(result.lines, [`Too big to fit: backup.zip (17.0 MB). ${FILELINK_HINT}`]);
  });
});

describe('a second fit', () => {
  it('does not save a photo again for a gain of less than 5 %', async () => {
    const env = setup({
      apiKey: '',
      list: [
        attachment('IMG_1.jpg', 1.3 * MB, 'jpeg', { standard: 1.26 * MB }),
        attachment('backup.zip', 17 * MB),
      ],
    });
    await fit(env);
    assert.equal(env.compose.state.updates.length, 0);
  });
});

describe('safety', () => {
  it('an attachment removed meanwhile is left alone', async () => {
    const env = setup({
      list: [
        attachment('IMG_1.jpg', 9 * MB, 'jpeg'),
        attachment('IMG_2.jpg', 9 * MB, 'jpeg'),
        attachment('contract.docx', 7 * MB),
      ],
    });
    const read = env.compose.getAttachmentFile;
    env.compose.getAttachmentFile = async (id) => {
      const file = await read(id);
      // The person removes the second photo while the first is read.
      if (id === 2) env.compose.attachments.splice(1, 1);
      return file;
    };
    const result = await fit(env);
    assert.deepEqual(
      env.compose.state.updates.map((u) => u.id),
      [1],
    );
    assert.equal(
      result.lines[0],
      'IMG_2.jpg was changed or removed meanwhile, so it was left alone.',
    );
  });

  it('a closed message window ends the fit with a plain message', async () => {
    const env = setup({ list: [attachment('IMG_1.jpg', 20 * MB, 'jpeg')] });
    env.compose.state.open = false;
    const result = await fit(env);
    assert.equal(result.state, 'error');
    assert.equal(
      result.text,
      'The message window was closed, so its attachments were not changed.',
    );
  });

  it('one fit at a time per message; the tab closing turns a price down', async () => {
    const env = setup({ list: [attachment('report.pdf', 18 * MB, 'pdf')] });
    const running = env.fitter.start({ tabId: 7, targetMb: 16 });
    assert.throws(() => env.fitter.start({ tabId: 7, targetMb: 16 }), /already being fitted/);
    for (let i = 0; i < 200 && env.fitter.get(7)?.state !== 'quoted'; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(env.fitter.busy, true);
    env.fitter.forgetTab(7);
    const result = await running;
    assert.equal(env.api.confirmed.length, 0);
    assert.equal(result.state, 'done');
    assert.equal(env.fitter.busy, false);
  });
});
