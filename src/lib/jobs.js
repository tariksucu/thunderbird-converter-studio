import { credits } from './client.js';
import { ConverterStudioError, ERROR_TEXT, asConverterStudioError } from './errors.js';
import {
  formatBytes,
  formatOf,
  isCompression,
  optionsFor,
  outputName,
  targetsFor,
} from './formats.js';

/**
 * The conversions in progress and their outcome, one per attachment: read the attachment from
 * Thunderbird, convert it with Converter Studio, then put the result back into the message being
 * written (replacing the attachment or beside it) or save it to disk. The popups only show this
 * state and send commands; the work runs here, in the background page, so closing a popup does
 * not stop it.
 *
 * Everything Thunderbird-specific comes in through `deps`, so the tests run it with fakes.
 */

/** Phases a job passes through, as the popups show them. */
const PHASE_TEXT = {
  reading: 'Reading the attachment…',
  uploading: 'Sending to Converter Studio…',
  fetching: 'Sending to Converter Studio…',
  waiting_for_upload: 'Sending to Converter Studio…',
  measuring: 'Working out the price…',
  queued: 'Waiting for a converter…',
  processing: 'Converting…',
  downloading: 'Downloading the result…',
  attaching: 'Attaching the converted file…',
  saving: 'Saving the converted file…',
};

const ACTIVE = new Set(['working', 'quoted']);

/**
 * @typedef {{
 *   key: string, kind: 'compose' | 'message', tabId: number, name: string, to: string,
 *   mode?: 'replace' | 'add', state: 'working' | 'quoted' | 'done' | 'error',
 *   phase?: string, progress?: number | null, text: string, credits?: number | null,
 *   resultName?: string, savedPath?: string
 * }} Job
 */

export const composeKey = (tabId, attachmentId) => `c:${tabId}:${attachmentId}`;
export const messageKey = (tabId, messageId, partName) => `m:${tabId}:${messageId}:${partName}`;

export class Jobs {
  /**
   * @param {{
   *   compose: { listAttachments(tabId: number): Promise<any[]>, getAttachmentFile(id: number): Promise<File>,
   *              updateAttachment(tabId: number, id: number, a: object): Promise<any>, addAttachment(tabId: number, a: object): Promise<any> },
   *   messages: { getAttachmentFile(messageId: number, partName: string): Promise<File> },
   *   save: (file: File) => Promise<string>,
   *   settings: () => Promise<{ apiKey: string, baseUrl: string, maxCredits: number }>,
   *   client: (settings: object) => import('./client.js').ConverterStudioClient,
   *   catalog: (client: import('./client.js').ConverterStudioClient) => Promise<import('./formats.js').Catalog>,
   *   onChange?: (job: Job) => void,
   *   timeoutMs?: number,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, Job>} */
    this.jobs = new Map();
    /** Go-aheads waited for by quoted jobs: key → resolve(true | false). */
    this.answers = new Map();
  }

  /** The jobs of a tab, for its popup. */
  list(tabId) {
    return [...this.jobs.values()].filter((job) => job.tabId === tabId);
  }

  /** How many jobs of a tab are still running (the toolbar button's badge). */
  running(tabId) {
    return this.list(tabId).filter((job) => ACTIVE.has(job.state)).length;
  }

  /** Whether any job still runs (the background page must stay awake for it). */
  get busy() {
    return [...this.jobs.values()].some((job) => ACTIVE.has(job.state));
  }

  /** Forgets a tab's jobs once the tab is gone; a running job finds its tab gone by itself. */
  forgetTab(tabId) {
    for (const [key, job] of this.jobs)
      if (job.tabId === tabId && !ACTIVE.has(job.state)) this.jobs.delete(key);
  }

  /** Forgets a finished job (the popup's "dismiss"). */
  dismiss(key) {
    const job = this.jobs.get(key);
    if (job && !ACTIVE.has(job.state)) this.jobs.delete(key);
  }

  /** The go-ahead for a conversion that costs more than the options allow, or not. */
  answer(key, yes) {
    const resolve = this.answers.get(key);
    if (!resolve) return false;
    this.answers.delete(key);
    resolve(Boolean(yes));
    return true;
  }

  /**
   * Converts an attachment of the message being written in `tabId`, then replaces it with the
   * result (`replace`) or attaches the result beside it (`add`).
   */
  convertComposeAttachment({ tabId, attachmentId, to, mode }) {
    const key = composeKey(tabId, attachmentId);
    return this.run(
      key,
      { kind: 'compose', tabId, to, mode: mode === 'add' ? 'add' : 'replace' },
      async (job) => {
        const attachment = await this.findComposeAttachment(tabId, attachmentId);
        job.name = attachment.name ?? 'file';
        this.update(job, { phase: 'reading' });
        const file = await this.read(() => this.deps.compose.getAttachmentFile(attachmentId));
        const result = await this.convert(job, file, job.name, to);
        if (!result) return;
        this.update(job, { phase: 'attaching' });
        const attached = new File([result.blob], result.name, { type: result.type });
        try {
          if (job.mode === 'replace') {
            await this.findComposeAttachment(tabId, attachmentId);
            await this.deps.compose.updateAttachment(tabId, attachmentId, {
              file: attached,
              name: result.name,
            });
          } else {
            await this.deps.compose.addAttachment(tabId, { file: attached, name: result.name });
          }
        } catch (error) {
          if (error instanceof ConverterStudioError) throw error;
          throw new ConverterStudioError(
            (await this.tabOpen(tabId)) ? 'attachFailed' : 'composeGone',
          );
        }
        const size = formatBytes(result.blob.size);
        this.finish(job, {
          resultName: result.name,
          text:
            job.mode === 'replace'
              ? `Replaced with ${result.name} (${size}).`
              : `Added ${result.name} (${size}) beside the original.`,
        });
      },
    );
  }

  /** Converts an attachment of a received message and saves the result to disk. */
  convertMessageAttachment({ tabId, messageId, partName, name, to }) {
    const key = messageKey(tabId, messageId, partName);
    return this.run(key, { kind: 'message', tabId, to, name }, async (job) => {
      this.update(job, { phase: 'reading' });
      const file = await this.read(() => this.deps.messages.getAttachmentFile(messageId, partName));
      const result = await this.convert(job, file, job.name, to);
      if (!result) return;
      this.update(job, { phase: 'saving' });
      let savedPath;
      try {
        savedPath = await this.deps.save(
          new File([result.blob], result.name, { type: result.type }),
        );
      } catch (error) {
        throw error instanceof ConverterStudioError
          ? error
          : new ConverterStudioError('saveFailed');
      }
      // The folder's name only: the whole path is long, and shows the user's account name.
      const parts = String(savedPath ?? '')
        .split(/[\\/]/)
        .filter(Boolean);
      const savedName = parts.at(-1) || result.name;
      const folder = parts.length > 1 ? ` in ${parts.at(-2)}` : '';
      this.finish(job, {
        resultName: savedName,
        text: `Saved ${savedName} (${formatBytes(result.blob.size)})${folder}.`,
      });
    });
  }

  /**
   * Runs one job: one at a time per attachment (a second start throws `busy` at once), errors
   * kept on the job with the API's words.
   */
  run(key, fields, work) {
    const existing = this.jobs.get(key);
    if (existing && ACTIVE.has(existing.state)) throw new ConverterStudioError('busy');
    /** @type {Job} */
    const job = {
      key,
      name: fields.name ?? 'file',
      state: 'working',
      text: '',
      progress: null,
      ...fields,
    };
    this.jobs.set(key, job);
    this.update(job, { phase: 'reading' });
    return this.execute(job, work);
  }

  async execute(job, work) {
    const { key } = job;
    try {
      await work(job);
    } catch (error) {
      const e = asConverterStudioError(error);
      this.finish(job, { state: 'error', text: e.message, code: e.code });
    } finally {
      this.answers.delete(key);
    }
    return job;
  }

  /**
   * Upload, convert and download; `null` when there is nothing to attach (a PDF that would not
   * get smaller, or a price the user turned down).
   */
  async convert(job, file, name, to) {
    const settings = await this.deps.settings();
    if (!settings.apiKey) throw new ConverterStudioError('notConfigured');
    const client = this.deps.client(settings);
    const catalog = await this.deps.catalog(client);
    const from = formatOf(catalog, name);
    if (!from) throw new ConverterStudioError('unknownFormat');
    if (!targetsFor(catalog, from).some((t) => t.to === to))
      throw new ConverterStudioError('unsupportedConversion');
    if (!file || !file.size) throw new ConverterStudioError('sourceEmpty');

    this.update(job, { phase: 'uploading' });
    const upload = await client.upload(file, name);
    let view = await client.start({
      uploadId: upload.id,
      to,
      options: optionsFor(from, to),
      maxCredits: settings.maxCredits,
    });
    const onProgress = (v) =>
      this.update(job, {
        phase: v.status,
        progress: v.status === 'processing' ? v.progress : null,
      });
    view = await client.settle(view, { timeoutMs: this.deps.timeoutMs, onProgress });
    if (view.status === 'quoted') {
      this.update(job, {
        state: 'quoted',
        credits: view.credits,
        text: `This conversion costs ${credits(view.credits)}, more than the ${view.maxCredits ?? settings.maxCredits} allowed in the options.`,
      });
      const yes = await new Promise((resolve) => this.answers.set(job.key, resolve));
      if (!yes) {
        this.finish(job, {
          state: 'error',
          code: 'overMaxCredits',
          text: 'Not converted; nothing was charged.',
        });
        return null;
      }
      this.update(job, { state: 'working', phase: 'queued' });
      view = await client.settle(await client.confirm(view.id), {
        timeoutMs: this.deps.timeoutMs,
        onProgress,
      });
    }
    if (view.status !== 'done' || !view.downloadUrl) {
      const code =
        view.status === 'expired' ? 'fileExpired' : (view.error?.code ?? 'conversionFailed');
      throw new ConverterStudioError(code, view.error?.message ?? ERROR_TEXT[code]);
    }
    this.update(job, { phase: 'downloading', progress: null });
    const { blob, type } = await client.download(view.downloadUrl);
    if (isCompression(from, to) && blob.size >= file.size) {
      this.finish(job, { state: 'done', text: ERROR_TEXT.notSmaller, resultName: name });
      return null;
    }
    return { blob, type, name: view.outputName || outputName(catalog, name, to) };
  }

  async findComposeAttachment(tabId, attachmentId) {
    let attachments;
    try {
      attachments = await this.deps.compose.listAttachments(tabId);
    } catch {
      throw new ConverterStudioError('composeGone');
    }
    const attachment = attachments.find((a) => a.id === attachmentId);
    if (!attachment) throw new ConverterStudioError('attachmentGone');
    return attachment;
  }

  async read(getFile) {
    try {
      return await getFile();
    } catch {
      throw new ConverterStudioError('sourceUnreadable');
    }
  }

  async tabOpen(tabId) {
    try {
      await this.deps.compose.listAttachments(tabId);
      return true;
    } catch {
      return false;
    }
  }

  update(job, fields) {
    Object.assign(job, fields);
    if (job.state === 'working') {
      const percent =
        job.phase === 'processing' && typeof job.progress === 'number'
          ? ` ${Math.round(job.progress * 100)}%`
          : '';
      job.text = `${PHASE_TEXT[job.phase] ?? PHASE_TEXT.processing}${percent}`;
    }
    this.deps.onChange?.({ ...job });
  }

  finish(job, fields) {
    Object.assign(job, { state: 'done', phase: undefined, progress: null }, fields);
    this.deps.onChange?.({ ...job });
  }
}
