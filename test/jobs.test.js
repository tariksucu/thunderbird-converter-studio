import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConverterStudioClient } from '../src/lib/client.js';
import { parseCatalog } from '../src/lib/formats.js';
import { Jobs, composeKey, messageKey } from '../src/lib/jobs.js';
import { BASE, FORMATS_BODY, fakeApi, fast, json } from './helpers.js';

/** A compose window with attachments, as Thunderbird's compose API shows it. */
function fakeCompose(names = ['IMG_0001.HEIC']) {
  const attachments = names.map((name, i) => ({
    id: i + 1,
    name,
    size: 12,
    file: new File([new Uint8Array(12)], name),
  }));
  let open = true;
  let nextId = 100;
  return {
    attachments,
    close: () => {
      open = false;
    },
    async listAttachments() {
      if (!open) throw new Error('Invalid tab ID: 7');
      return attachments.map(({ id, name, size }) => ({ id, name, size }));
    },
    async getAttachmentFile(id) {
      return attachments.find((a) => a.id === id).file;
    },
    async updateAttachment(tabId, id, { file, name }) {
      if (!open) throw new Error('Invalid tab ID');
      Object.assign(
        attachments.find((a) => a.id === id),
        { file, name, size: file.size },
      );
    },
    async addAttachment(tabId, { file, name }) {
      if (!open) throw new Error('Invalid tab ID');
      attachments.push({ id: nextId++, name, size: file.size, file });
    },
  };
}

function setup({ routes, names, settings, compose = fakeCompose(names), saved = [] } = {}) {
  const api = fakeApi(routes);
  const changes = [];
  const jobs = new Jobs({
    compose,
    messages: {
      getAttachmentFile: async (messageId, partName) =>
        new File([new Uint8Array(20)], `${messageId}-${partName}`),
    },
    save: async (file) => {
      saved.push(file);
      return `/home/me/Downloads/${file.name}`;
    },
    settings: async () => ({ apiKey: 'cvs_live_k', baseUrl: BASE, maxCredits: 20, ...settings }),
    client: (s) => new ConverterStudioClient({ ...s, fetch: api.fetch, ...fast }),
    catalog: async () => parseCatalog(FORMATS_BODY),
    onChange: (job) => changes.push(job),
  });
  return { api, jobs, compose, changes, saved };
}

describe('the compose window', () => {
  it('replaces an attachment with the converted file', async () => {
    const { jobs, compose, changes } = setup();
    const job = await jobs.convertComposeAttachment({
      tabId: 7,
      attachmentId: 1,
      to: 'jpg',
      mode: 'replace',
    });
    assert.equal(job.state, 'done', job.text);
    assert.equal(compose.attachments.length, 1);
    assert.equal(compose.attachments[0].name, 'IMG_0001.jpg');
    assert.equal(compose.attachments[0].file.type, 'image/jpeg');
    assert.deepEqual(
      [...new Uint8Array(await compose.attachments[0].file.arrayBuffer())].slice(0, 2),
      [0xff, 0xd8],
    );
    assert.match(job.text, /^Replaced with IMG_0001\.jpg \(7 bytes\)\.$/);
    // The popup saw each step.
    const phases = changes.map((c) => c.phase).filter(Boolean);
    for (const phase of ['reading', 'uploading', 'queued', 'downloading', 'attaching'])
      assert.ok(phases.includes(phase), phase);
    assert.equal(jobs.busy, false);
  });

  it('adds the converted file beside the original', async () => {
    const { jobs, compose } = setup({
      names: ['Report.docx'],
      routes: {
        'GET /v1/conversions/:id': {
          id: 'x',
          status: 'done',
          outputName: 'Report.pdf',
          downloadUrl: `${BASE}/jobs/x/download?token=d`,
        },
      },
    });
    const job = await jobs.convertComposeAttachment({
      tabId: 7,
      attachmentId: 1,
      to: 'pdf',
      mode: 'add',
    });
    assert.equal(job.state, 'done', job.text);
    assert.deepEqual(
      compose.attachments.map((a) => a.name),
      ['Report.docx', 'Report.pdf'],
    );
    assert.match(job.text, /^Added Report\.pdf/);
  });

  it('keeps a PDF that does not get smaller', async () => {
    const compose = fakeCompose(['scan.pdf']);
    compose.attachments[0].file = new File([new Uint8Array(5)], 'scan.pdf');
    const { jobs, api } = setup({ compose });
    const job = await jobs.convertComposeAttachment({
      tabId: 7,
      attachmentId: 1,
      to: 'pdf',
      mode: 'replace',
    });
    assert.equal(job.state, 'done');
    assert.equal(job.text, 'The PDF could not be made smaller, so the original was kept.');
    assert.equal(compose.attachments[0].name, 'scan.pdf');
    assert.deepEqual(api.requests.find((r) => r.key === 'POST /v1/conversions').body.options, {
      compression: 'balanced',
    });
  });

  it("shows the API's message when the conversion fails, and keeps the attachment", async () => {
    const { jobs, compose } = setup({
      routes: {
        'GET /v1/conversions/:id': {
          id: 'x',
          status: 'failed',
          error: {
            code: 'conversionFailed',
            message: 'The file could not be converted. No credits were used.',
          },
        },
      },
    });
    const job = await jobs.convertComposeAttachment({
      tabId: 7,
      attachmentId: 1,
      to: 'jpg',
      mode: 'replace',
    });
    assert.equal(job.state, 'error');
    assert.equal(job.code, 'conversionFailed');
    assert.equal(job.text, 'The file could not be converted. No credits were used.');
    assert.equal(compose.attachments[0].name, 'IMG_0001.HEIC');
  });

  it("shows the API's message for a wrong key", async () => {
    const { jobs } = setup({
      routes: {
        'POST /v1/uploads': {
          status: 401,
          body: { error: { code: 'invalidApiKey', message: 'This API key does not work.' } },
        },
      },
    });
    const job = await jobs.convertComposeAttachment({ tabId: 7, attachmentId: 1, to: 'jpg' });
    assert.equal(job.state, 'error');
    assert.equal(job.text, 'This API key does not work.');
  });

  it('asks for a key before anything is read or sent', async () => {
    const { jobs, api } = setup({ settings: { apiKey: '' } });
    const job = await jobs.convertComposeAttachment({ tabId: 7, attachmentId: 1, to: 'jpg' });
    assert.equal(job.code, 'notConfigured');
    assert.equal(api.requests.length, 0);
  });

  it('refuses a format the API does not offer for the file, and files it does not read', async () => {
    const { jobs, api } = setup({ names: ['IMG_0001.HEIC', 'setup.exe'] });
    assert.equal(
      (await jobs.convertComposeAttachment({ tabId: 7, attachmentId: 1, to: 'mp3' })).code,
      'unsupportedConversion',
    );
    assert.equal(
      (await jobs.convertComposeAttachment({ tabId: 7, attachmentId: 2, to: 'jpg' })).code,
      'unknownFormat',
    );
    assert.equal(api.requests.length, 0);
  });

  it('says so when the message window was closed during the conversion', async () => {
    const compose = fakeCompose();
    const { jobs } = setup({
      compose,
      routes: {
        'GET /v1/conversions/:id': () => {
          compose.close();
          return json(200, {
            id: 'x',
            status: 'done',
            outputName: 'IMG_0001.jpg',
            downloadUrl: `${BASE}/jobs/x/download?token=d`,
          });
        },
      },
    });
    const job = await jobs.convertComposeAttachment({
      tabId: 7,
      attachmentId: 1,
      to: 'jpg',
      mode: 'replace',
    });
    assert.equal(job.code, 'composeGone');
  });

  it('says so when the attachment was removed during the conversion', async () => {
    const compose = fakeCompose();
    const { jobs } = setup({
      compose,
      routes: {
        'GET /v1/conversions/:id': () => {
          compose.attachments.length = 0;
          return json(200, {
            id: 'x',
            status: 'done',
            downloadUrl: `${BASE}/jobs/x/download?token=d`,
          });
        },
      },
    });
    assert.equal(
      (await jobs.convertComposeAttachment({ tabId: 7, attachmentId: 1, to: 'jpg' })).code,
      'attachmentGone',
    );
  });

  it('runs one conversion at a time per attachment', async () => {
    let release;
    const { jobs } = setup({
      routes: {
        'GET /v1/conversions/:id': () =>
          new Promise(
            (r) =>
              (release = () =>
                r(
                  json(200, {
                    id: 'x',
                    status: 'done',
                    downloadUrl: `${BASE}/jobs/x/download?token=d`,
                  }),
                )),
          ),
      },
    });
    const first = jobs.convertComposeAttachment({ tabId: 7, attachmentId: 1, to: 'jpg' });
    assert.throws(() => jobs.convertComposeAttachment({ tabId: 7, attachmentId: 1, to: 'png' }), {
      code: 'busy',
    });
    assert.equal(jobs.running(7), 1);
    assert.equal(jobs.busy, true);
    while (!release) await new Promise((r) => setTimeout(r, 1));
    release();
    assert.equal((await first).state, 'done');
    assert.equal(jobs.running(7), 0);
  });

  it('waits for a go-ahead when the price is over the limit, then converts', async () => {
    let confirmed = false;
    const { jobs, compose } = setup({
      routes: {
        'GET /v1/conversions/:id': () =>
          json(
            200,
            confirmed
              ? { id: 'v', status: 'done', downloadUrl: `${BASE}/jobs/v/download?token=d` }
              : { id: 'v', status: 'quoted', credits: 30, maxCredits: 20 },
          ),
        'POST /v1/conversions/v/confirm': () => {
          confirmed = true;
          return json(200, { id: 'v', status: 'queued' });
        },
      },
    });
    const running = jobs.convertComposeAttachment({ tabId: 7, attachmentId: 1, to: 'jpg' });
    const key = composeKey(7, 1);
    while (jobs.jobs.get(key)?.state !== 'quoted') await new Promise((r) => setTimeout(r, 1));
    assert.equal(
      jobs.jobs.get(key).text,
      'This conversion costs 30 credits, more than the 20 allowed in the options.',
    );
    assert.equal(jobs.busy, true);
    assert.equal(jobs.answer(key, true), true);
    const job = await running;
    assert.equal(job.state, 'done', job.text);
    assert.equal(compose.attachments[0].name, 'IMG_0001.jpg');
  });

  it('converts nothing when the go-ahead is refused', async () => {
    const { jobs, compose, api } = setup({
      routes: {
        'GET /v1/conversions/:id': { id: 'v', status: 'quoted', credits: 30, maxCredits: 20 },
      },
    });
    const running = jobs.convertComposeAttachment({ tabId: 7, attachmentId: 1, to: 'jpg' });
    const key = composeKey(7, 1);
    while (jobs.jobs.get(key)?.state !== 'quoted') await new Promise((r) => setTimeout(r, 1));
    jobs.answer(key, false);
    const job = await running;
    assert.equal(job.state, 'error');
    assert.equal(job.text, 'Not converted; nothing was charged.');
    assert.equal(compose.attachments[0].name, 'IMG_0001.HEIC');
    assert.ok(!api.requests.some((r) => r.key.endsWith('/confirm')));
  });

  it('forgets finished jobs of a closed tab, and dismissed ones', async () => {
    const { jobs } = setup();
    await jobs.convertComposeAttachment({ tabId: 7, attachmentId: 1, to: 'jpg' });
    assert.equal(jobs.list(7).length, 1);
    jobs.dismiss(composeKey(7, 1));
    assert.equal(jobs.list(7).length, 0);
    await jobs.convertComposeAttachment({ tabId: 7, attachmentId: 1, to: 'png' });
    jobs.forgetTab(7);
    assert.equal(jobs.list(7).length, 0);
  });
});

describe('the message window', () => {
  it('converts a received attachment and saves it', async () => {
    const saved = [];
    const { jobs } = setup({
      saved,
      routes: {
        'GET /v1/conversions/:id': {
          id: 'x',
          status: 'done',
          outputName: 'Report.pdf',
          downloadUrl: `${BASE}/jobs/x/download?token=d`,
        },
      },
    });
    const job = await jobs.convertMessageAttachment({
      tabId: 3,
      messageId: 42,
      partName: '1.2',
      name: 'Report.docx',
      to: 'pdf',
    });
    assert.equal(job.state, 'done', job.text);
    assert.equal(job.key, messageKey(3, 42, '1.2'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'Report.pdf');
    assert.equal(job.text, 'Saved Report.pdf (7 bytes) in Downloads.');
  });

  it('names the file as saved (Thunderbird adds a number to a name already taken)', async () => {
    const { jobs } = setup({
      routes: {
        'GET /v1/conversions/:id': {
          id: 'x',
          status: 'done',
          outputName: 'Report.pdf',
          downloadUrl: `${BASE}/jobs/x/download?token=d`,
        },
      },
    });
    jobs.deps.save = async () => 'C:\\Users\\me\\Downloads\\Report(1).pdf';
    const job = await jobs.convertMessageAttachment({
      tabId: 3,
      messageId: 42,
      partName: '1.2',
      name: 'Report.docx',
      to: 'pdf',
    });
    assert.equal(job.text, 'Saved Report(1).pdf (7 bytes) in Downloads.');
  });

  it('says so when the file could not be saved', async () => {
    const { jobs } = setup();
    jobs.deps.save = async () => {
      throw new Error('disk full');
    };
    const job = await jobs.convertMessageAttachment({
      tabId: 3,
      messageId: 42,
      partName: '1.2',
      name: 'IMG.heic',
      to: 'jpg',
    });
    assert.equal(job.code, 'saveFailed');
  });

  it('says so when Thunderbird cannot read the attachment', async () => {
    const { jobs } = setup();
    jobs.deps.messages.getAttachmentFile = async () => {
      throw new Error('Message not found');
    };
    const job = await jobs.convertMessageAttachment({
      tabId: 3,
      messageId: 42,
      partName: '1.2',
      name: 'IMG.heic',
      to: 'jpg',
    });
    assert.equal(job.code, 'sourceUnreadable');
  });
});
