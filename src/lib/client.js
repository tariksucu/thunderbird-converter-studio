import { ConverterStudioError, ERROR_TEXT } from './errors.js';

/**
 * A small client for Converter Studio's public REST API (https://converter.studio/developers):
 * upload a file, convert it, wait for the result and download it, with the `fetch` Thunderbird
 * gives add-ons. No dependencies.
 *
 * The API key only goes with requests to the API's own address (`Authorization: Bearer`). Upload
 * and download links carry their own one-time tokens, so the key is never sent with them, and a
 * link to any other address is refused. The key never appears in an error or a log.
 */

/** Names this add-on on its API calls (Converter Studio's statistics of its connectors). */
export const CLIENT_NAME = 'thunderbird';
/** One upload request carries at most this much when the API does not say (the CDN stops at 100 MB). */
export const DEFAULT_PART_BYTES = 95 * 1024 * 1024;
/** The longest file name the API takes. */
const MAX_NAME_LENGTH = 255;
/** States after which a conversion changes no more on its own. */
const SETTLED = new Set(['done', 'failed', 'expired', 'canceled', 'quoted']);
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A file name the API takes: at most 255 characters, keeping its extension. */
export function uploadName(name) {
  const trimmed =
    String(name ?? '')
      .replace(/[\r\n\0]/g, '')
      .trim() || 'file';
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
  const dot = trimmed.lastIndexOf('.');
  const extension = dot > 0 && trimmed.length - dot <= 16 ? trimmed.slice(dot) : '';
  return trimmed.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
}

/** "1 credit", "3 credits". */
export const credits = (n) =>
  n === null || n === undefined
    ? 'an unknown number of credits'
    : `${n} credit${n === 1 ? '' : 's'}`;

export class ConverterStudioClient {
  /**
   * @param {{
   *   apiKey: string,
   *   baseUrl: string,
   *   version: string,
   *   fetch?: typeof fetch,
   *   sleep?: (ms: number) => Promise<void>,
   *   retries?: number,
   *   newKey?: () => string,
   * }} options
   */
  constructor(options) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.origin = new URL(this.baseUrl).origin;
    this.clientHeader = `${CLIENT_NAME}/${options.version}`;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.retries = options.retries ?? 3;
    this.newKey = options.newKey ?? (() => crypto.randomUUID());
  }

  /** The formats the API reads and what each converts to. Needs no key. */
  formats() {
    return this.json('GET', '/v1/formats', undefined, { auth: false });
  }

  /** The account behind the key: plan and credits. */
  account() {
    return this.json('GET', '/v1/account');
  }

  /**
   * Sends a file's bytes: an upload slot (the API checks the plan's size limit before anything
   * is sent), then the bytes in one request, or in parts with `Upload-Offset` for a large file.
   * @param {Blob} file
   * @param {string} fileName
   * @returns {Promise<{ id: string, format: string | null }>}
   */
  async upload(file, fileName) {
    if (!(file.size > 0)) throw new ConverterStudioError('sourceEmpty');
    const slot = await this.json('POST', '/v1/uploads', {
      fileName: uploadName(fileName),
      size: file.size,
    });
    this.checkLink(slot.uploadUrl);
    const partBytes = slot.partBytes > 0 ? slot.partBytes : DEFAULT_PART_BYTES;
    const inParts = file.size > partBytes;
    for (let offset = 0; offset < file.size;) {
      const part = file.slice(offset, Math.min(file.size, offset + partBytes));
      const receipt = await this.sendPart(slot.uploadUrl, part, inParts ? offset : null);
      offset += part.size;
      if (receipt?.status === 'ready') {
        if (offset !== file.size) break;
        return { id: slot.id, format: receipt.file?.format ?? null };
      }
      if (receipt?.status !== 'partial' || receipt.received !== offset) break;
    }
    throw new ConverterStudioError('uploadIncomplete');
  }

  /**
   * Starts converting an upload. Sent again after a lost answer, with the same
   * `Idempotency-Key`, so a retry never makes a second conversion or a second charge.
   */
  start({ uploadId, to, options, maxCredits }) {
    const body = { uploadId, to, maxCredits };
    if (options && Object.keys(options).length) body.options = options;
    return this.json('POST', '/v1/conversions', body, { idempotencyKey: this.newKey() });
  }

  /** A conversion's state; with `waitSeconds`, the API answers when it settles or the time is up. */
  get(id, waitSeconds = 0) {
    const query = waitSeconds > 0 ? `?wait=${Math.min(60, Math.ceil(waitSeconds))}` : '';
    return this.json('GET', `/v1/conversions/${encodeURIComponent(id)}${query}`, undefined, {
      timeoutMs: (waitSeconds + 30) * 1000,
    });
  }

  /** Goes ahead with a conversion that costs more than its `maxCredits` (status `quoted`). */
  confirm(id) {
    return this.json('POST', `/v1/conversions/${encodeURIComponent(id)}/confirm`);
  }

  /**
   * Waits until the conversion settles (done, failed, expired, canceled or quoted), telling
   * `onProgress` how it goes. Asks every few seconds, longer as the work goes on.
   * @param {object} view the conversion as `start` or `get` returned it
   * @param {{ timeoutMs?: number, onProgress?: (view: object) => void }} [options]
   */
  async settle(view, { timeoutMs = 30 * 60_000, onProgress } = {}) {
    const deadline = Date.now() + timeoutMs;
    let current = view;
    for (let round = 0; !SETTLED.has(current.status); round++) {
      onProgress?.(current);
      const left = deadline - Date.now();
      if (left <= 0)
        throw new ConverterStudioError('timeout', undefined, { params: { id: current.id } });
      const wait = Math.max(1, Math.min(2 + round, 10, Math.floor(left / 1000)));
      current = await this.get(current.id, wait);
    }
    return current;
  }

  /**
   * The converted file. The link carries its own token (no key is sent) and must be on the API's
   * address.
   * @returns {Promise<{ blob: Blob, type: string }>}
   */
  async download(downloadUrl) {
    this.checkLink(downloadUrl);
    const response = await this.send(
      downloadUrl,
      { method: 'GET', headers: { 'X-Converter-Studio-Client': this.clientHeader } },
      'resultDownloadFailed',
      30 * 60_000,
    );
    const blob = await response.blob();
    if (!blob.size) throw new ConverterStudioError('resultDownloadFailed');
    const type = (response.headers.get('content-type') || '').split(';')[0].trim();
    return { blob, type: type || 'application/octet-stream' };
  }

  /** Refuses a link to another address than the API's (the API's own links never are). */
  checkLink(link) {
    let url;
    try {
      url = new URL(link);
    } catch {
      throw new ConverterStudioError('foreignLink');
    }
    if (url.origin !== this.origin) throw new ConverterStudioError('foreignLink');
  }

  /** One request of an upload; a lost connection or a busy server sends it again (the API overwrites). */
  async sendPart(uploadUrl, part, offset) {
    const headers = {
      'Content-Type': 'application/octet-stream',
      'X-Converter-Studio-Client': this.clientHeader,
    };
    if (offset !== null) headers['Upload-Offset'] = String(offset);
    const response = await this.send(
      uploadUrl,
      { method: 'PUT', headers, body: part },
      'uploadIncomplete',
      120_000 + Math.ceil(part.size / 1_000_000) * 2000,
    );
    return response.json().catch(() => null);
  }

  /** A request to the API, with the key unless `auth` is false; its JSON body. */
  async json(method, path, body, { auth = true, idempotencyKey, timeoutMs = 60_000 } = {}) {
    if (auth && !this.apiKey) throw new ConverterStudioError('notConfigured');
    const headers = { Accept: 'application/json', 'X-Converter-Studio-Client': this.clientHeader };
    if (auth) headers.Authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await this.send(
      `${this.baseUrl}${path}`,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      'network',
      timeoutMs,
    );
    try {
      return await response.json();
    } catch {
      throw new ConverterStudioError('notJson', undefined, { status: response.status });
    }
  }

  /** Sends a request, trying again a few times while the API is busy or unreachable. */
  async send(url, init, failure, timeoutMs) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetch(url, {
          ...init,
          // The key is the only credential: never the cookies of a converter.studio session.
          credentials: 'omit',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt < this.retries) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ConverterStudioError(
          failure,
          failure === 'network' ? ERROR_TEXT.network : undefined,
        );
      }
      // Followed redirects must stay on the API's address (browsers drop the key on others).
      if (response.url) this.checkLink(response.url);
      if (response.ok) return response;
      const error = await readError(response);
      const lasting = error.code === 'tooManyPending' || error.code === 'tooManyUnconverted';
      if (RETRY_STATUS.has(response.status) && attempt < this.retries && !lasting) {
        const wait = error.retryAfter !== null ? error.retryAfter * 1000 : 1000 * 2 ** attempt;
        await this.sleep(Math.min(wait, 30_000));
        continue;
      }
      throw error;
    }
  }
}

/** The API's error body (`{ error: { code, message, params } }`) as a ConverterStudioError. */
async function readError(response) {
  const header = response.headers.get('retry-after');
  const retryAfter = header && /^\d+$/.test(header) ? Number(header) : null;
  let code = null;
  let message = null;
  let params = null;
  try {
    const body = await response.json();
    if (typeof body?.error?.code === 'string') code = body.error.code;
    if (typeof body?.error?.message === 'string') message = body.error.message;
    if (body?.error?.params && typeof body.error.params === 'object') params = body.error.params;
  } catch {
    // Not JSON (a proxy's error page): the status says enough.
  }
  if (!code) {
    if (response.status === 401) code = 'invalidApiKey';
    else if (response.status === 402) code = 'notEnoughCredits';
    else if (response.status === 413) code = 'fileTooLarge';
    else if (response.status === 429) code = 'tooManyRequests';
    else if (response.status >= 500) code = 'serverBusy';
    else code = 'unknown';
  }
  return new ConverterStudioError(
    code,
    message ?? ERROR_TEXT[code] ?? `Converter Studio answered ${response.status}.`,
    {
      status: response.status,
      retryAfter,
      params,
    },
  );
}
