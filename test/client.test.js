import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConverterStudioClient, credits, uploadName } from '../src/lib/client.js';
import { ConverterStudioError } from '../src/lib/errors.js';
import { BASE, fakeApi, fast, json } from './helpers.js';

const client = (api, extra = {}) =>
  new ConverterStudioClient({
    apiKey: 'cvs_live_secret',
    baseUrl: BASE,
    fetch: api.fetch,
    ...fast,
    ...extra,
  });
const file = (bytes = 12, name = 'IMG_0001.HEIC') => new File([new Uint8Array(bytes)], name);

describe('requests', () => {
  it('sends the key only to the API, and the client header on every request', async () => {
    const api = fakeApi();
    const c = client(api);
    const upload = await c.upload(file(), 'IMG_0001.HEIC');
    const view = await c.start({ uploadId: upload.id, to: 'jpg', maxCredits: 20 });
    const done = await c.settle(view);
    await c.download(done.downloadUrl);
    for (const r of api.requests) {
      assert.equal(r.headers['x-converter-studio-client'], 'thunderbird/1.0.0', r.key);
      assert.equal(r.init.credentials, 'omit', r.key);
      const withKey = r.key.startsWith('POST /v1/uploads') || r.key.includes('/v1/conversions');
      assert.equal(r.headers.authorization, withKey ? 'Bearer cvs_live_secret' : undefined, r.key);
    }
    assert.deepEqual(
      api.requests.map((r) => r.key),
      [
        'POST /v1/uploads',
        'PUT /v1/uploads/up_12345678',
        'POST /v1/conversions',
        'GET /v1/conversions/up_12345678',
        'GET /jobs/up_12345678/download',
      ],
    );
  });

  it('lists the formats without a key', async () => {
    const api = fakeApi();
    const body = await new ConverterStudioClient({
      apiKey: '',
      baseUrl: BASE,
      fetch: api.fetch,
      ...fast,
    }).formats();
    assert.ok(body.formats.length > 5);
    assert.equal(api.requests[0].headers.authorization, undefined);
  });

  it('refuses to call the API without a key', async () => {
    const api = fakeApi();
    const c = new ConverterStudioClient({ apiKey: '', baseUrl: BASE, fetch: api.fetch, ...fast });
    await assert.rejects(c.account(), { code: 'notConfigured' });
    assert.equal(api.requests.length, 0);
  });

  it('starts a conversion with an Idempotency-Key, the credit limit and the options', async () => {
    const api = fakeApi();
    await client(api).start({
      uploadId: 'up_12345678',
      to: 'pdf',
      options: { compression: 'balanced' },
      maxCredits: 7,
    });
    const [r] = api.requests;
    assert.equal(r.headers['idempotency-key'], 'key-1');
    assert.deepEqual(r.body, {
      uploadId: 'up_12345678',
      to: 'pdf',
      maxCredits: 7,
      options: { compression: 'balanced' },
    });
  });

  it('sends a lost conversion request again with the same Idempotency-Key', async () => {
    let calls = 0;
    const api = fakeApi({
      'POST /v1/conversions': () => {
        calls += 1;
        if (calls === 1) throw new TypeError('NetworkError when attempting to fetch resource.');
        return json(201, { id: 'up_12345678', status: 'queued' });
      },
    });
    await client(api, {
      newKey: (() => {
        let n = 0;
        return () => `key-${++n}`;
      })(),
    }).start({ uploadId: 'up_12345678', to: 'jpg', maxCredits: 20 });
    const keys = api.requests
      .filter((r) => r.key === 'POST /v1/conversions')
      .map((r) => r.headers['idempotency-key']);
    assert.deepEqual(keys, ['key-1', 'key-1']);
  });

  it('waits on the server, a little longer each time, and reports progress', async () => {
    const states = ['queued', 'processing', 'processing', 'done'];
    let i = 0;
    const api = fakeApi({
      'GET /v1/conversions/:id': () => {
        const status = states[i++];
        return json(200, {
          id: 'up_12345678',
          status,
          progress: status === 'processing' ? 0.5 : null,
          downloadUrl: status === 'done' ? `${BASE}/jobs/x/download?token=d` : null,
        });
      },
    });
    const seen = [];
    const view = await client(api).settle(
      { id: 'up_12345678', status: 'queued' },
      { onProgress: (v) => seen.push(v.status) },
    );
    assert.equal(view.status, 'done');
    assert.deepEqual(seen, ['queued', 'queued', 'processing', 'processing']);
    assert.deepEqual(
      api.requests.map((r) => r.search),
      ['?wait=2', '?wait=3', '?wait=4', '?wait=5'],
    );
  });

  it('stops at a quoted price and confirms it on request', async () => {
    const api = fakeApi({
      'GET /v1/conversions/:id': { id: 'v1', status: 'quoted', credits: 30, maxCredits: 20 },
      'POST /v1/conversions/v1/confirm': { id: 'v1', status: 'queued' },
    });
    const c = client(api);
    const view = await c.settle({ id: 'v1', status: 'measuring' });
    assert.equal(view.status, 'quoted');
    assert.equal((await c.confirm('v1')).status, 'queued');
    assert.equal(api.requests.at(-1).key, 'POST /v1/conversions/v1/confirm');
  });

  it('gives up after the time allowed', async () => {
    const api = fakeApi({ 'GET /v1/conversions/:id': { id: 'v1', status: 'processing' } });
    await assert.rejects(client(api).settle({ id: 'v1', status: 'queued' }, { timeoutMs: 0 }), {
      code: 'timeout',
    });
  });
});

describe('uploads', () => {
  it('sends a large file in parts with Upload-Offset', async () => {
    let received = 0;
    const api = fakeApi({
      'POST /v1/uploads': json(201, {
        id: 'up_parts',
        uploadUrl: `${BASE}/v1/uploads/up_parts?token=t`,
        partBytes: 10,
      }),
      'PUT /v1/uploads/up_parts': ({ headers, body }) => {
        assert.equal(Number(headers['upload-offset']), received);
        received += body.bytes;
        return json(
          200,
          received === 25
            ? { status: 'ready', file: { format: 'heic' } }
            : { status: 'partial', received },
        );
      },
    });
    const result = await client(api).upload(file(25), 'IMG.HEIC');
    assert.deepEqual(result, { id: 'up_parts', format: 'heic' });
    assert.deepEqual(
      api.requests.filter((r) => r.key.startsWith('PUT')).map((r) => r.body.bytes),
      [10, 10, 5],
    );
  });

  it('notices an upload that did not arrive whole', async () => {
    const api = fakeApi({
      'POST /v1/uploads': json(201, {
        id: 'up_x',
        uploadUrl: `${BASE}/v1/uploads/up_x?token=t`,
        partBytes: 10,
      }),
      'PUT /v1/uploads/up_x': json(200, { status: 'partial', received: 3 }),
    });
    await assert.rejects(client(api).upload(file(25), 'a.heic'), { code: 'uploadIncomplete' });
  });

  it('refuses an empty file before sending anything', async () => {
    const api = fakeApi();
    await assert.rejects(client(api).upload(file(0), 'a.heic'), { code: 'sourceEmpty' });
    assert.equal(api.requests.length, 0);
  });

  it('never follows a link to another address', async () => {
    const api = fakeApi({
      'POST /v1/uploads': json(201, {
        id: 'up_x',
        uploadUrl: 'https://evil.example/upload',
        partBytes: 10,
      }),
    });
    await assert.rejects(client(api).upload(file(5), 'a.heic'), { code: 'foreignLink' });
    assert.equal(api.requests.length, 1);
    await assert.rejects(client(api).download('https://evil.example/file'), {
      code: 'foreignLink',
    });
  });

  it('keeps the name the API takes (255 characters, extension kept)', () => {
    assert.equal(uploadName(' a\nb.heic '), 'ab.heic');
    const long = `${'x'.repeat(300)}.heic`;
    assert.equal(uploadName(long).length, 255);
    assert.ok(uploadName(long).endsWith('.heic'));
    assert.equal(uploadName(''), 'file');
  });
});

describe('errors', () => {
  it("shows the API's own message for a wrong key", async () => {
    const api = fakeApi({
      'GET /v1/account': {
        status: 401,
        body: { error: { code: 'invalidApiKey', message: 'This API key does not work.' } },
      },
    });
    await assert.rejects(
      client(api).account(),
      (e) =>
        e instanceof ConverterStudioError &&
        e.code === 'invalidApiKey' &&
        e.message === 'This API key does not work.' &&
        e.status === 401,
    );
    assert.equal(api.requests.length, 1, 'a 401 is not retried');
  });

  it('never puts the key in an error message', async () => {
    const api = fakeApi({ 'GET /v1/account': { status: 403, body: 'not json' } });
    await assert.rejects(client(api).account(), (e) => !e.message.includes('cvs_live_secret'));
  });

  it('falls back to its own words when the answer is not JSON', async () => {
    const api = fakeApi({
      'GET /v1/account': new Response('<html>Bad gateway</html>', { status: 402 }),
    });
    await assert.rejects(client(api).account(), {
      code: 'notEnoughCredits',
      message: 'Not enough credits left on the Converter Studio account.',
    });
  });

  it('tries a busy API again, waiting as Retry-After says', async () => {
    const waits = [];
    let calls = 0;
    const api = fakeApi({
      'GET /v1/account': () =>
        ++calls < 3
          ? json(503, { error: { code: 'serverBusy', message: 'Busy.' } }, { 'retry-after': '7' })
          : json(200, { plan: 'free', credits: 13 }),
    });
    const account = await client(api, { sleep: async (ms) => waits.push(ms) }).account();
    assert.equal(account.plan, 'free');
    assert.deepEqual(waits, [7000, 7000]);
  });

  it('stops retrying after a few tries and says the API cannot be reached', async () => {
    const api = fakeApi({
      'GET /v1/account': () => {
        throw new TypeError('NetworkError');
      },
    });
    await assert.rejects(client(api, { retries: 2 }).account(), { code: 'network' });
    assert.equal(api.requests.length, 3);
  });

  it('does not retry uploads that are paused for hours', async () => {
    const api = fakeApi({
      'POST /v1/uploads': {
        status: 429,
        body: { error: { code: 'tooManyUnconverted', message: 'Paused.' } },
      },
    });
    await assert.rejects(client(api).upload(file(), 'a.heic'), {
      code: 'tooManyUnconverted',
      message: 'Paused.',
    });
    assert.equal(api.requests.length, 1);
  });

  it('refuses a followed redirect to another address', async () => {
    const api = {
      fetch: async () =>
        Object.defineProperty(new Response('{}', { status: 200 }), 'url', {
          value: 'https://elsewhere.example/v1/account',
        }),
    };
    await assert.rejects(client(api).account(), { code: 'foreignLink' });
  });

  it('counts credits in words', () => {
    assert.equal(credits(1), '1 credit');
    assert.equal(credits(3), '3 credits');
    assert.equal(credits(null), 'an unknown number of credits');
  });
});
