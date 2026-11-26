import { normalizeTargetMb, EMAIL_ATTACHMENT_MB } from './fit.js';

/**
 * The add-on's settings, kept with `storage.local`: in this Thunderbird profile on this computer
 * only (never synced), readable by this add-on alone, and deleted when the add-on is removed.
 */

export const DEFAULT_BASE_URL = 'https://converter.studio/api';
/** The API's own default: a dearer conversion waits for a go-ahead and costs nothing until then. */
export const DEFAULT_MAX_CREDITS = 20;

export const DEFAULTS = Object.freeze({
  apiKey: '',
  baseUrl: DEFAULT_BASE_URL,
  maxCredits: DEFAULT_MAX_CREDITS,
  /** Compose window: `replace` the attachment, or `add` the converted file beside it. */
  composeMode: 'replace',
  /** "Fit attachments for sending": the total in MB, 16 (Gmail, Yahoo Mail) or 10. */
  fitTargetMb: EMAIL_ATTACHMENT_MB,
});

/** Hosts other than converter.studio the address may name: a test server on this computer. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * The address checked and tidied (no trailing slash), or `null` when it is not allowed: only
 * `https://converter.studio/…`, or `http(s)://localhost` and `127.0.0.1` with any port for a local
 * test server. The API key is sent to this address, so nothing else is accepted.
 * @param {string} value
 * @returns {string | null}
 */
export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const official = url.protocol === 'https:' && url.hostname === 'converter.studio' && !url.port;
  const local =
    (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname);
  if (!official && !local) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The host permissions an address needs beyond the manifest's `https://converter.studio/*`: both
 * local names (the API's links may name either), or none.
 * @param {string} baseUrl
 * @returns {string[]}
 */
export function originsFor(baseUrl) {
  const url = new URL(baseUrl);
  if (url.hostname === 'converter.studio') return [];
  return [`${url.protocol}//localhost/*`, `${url.protocol}//127.0.0.1/*`];
}

/** A credit limit from a form field: a whole number from 0 to 100000, else the default. */
export function normalizeMaxCredits(value) {
  if (value === '' || value === null || value === undefined) return DEFAULT_MAX_CREDITS;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : DEFAULT_MAX_CREDITS;
}

/**
 * The stored settings with defaults filled in.
 * @param {{ get(keys: string[]): Promise<Record<string, unknown>> }} storage `storage.local`
 */
export async function loadSettings(storage) {
  const stored = await storage.get(Object.keys(DEFAULTS));
  return {
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey.trim() : DEFAULTS.apiKey,
    baseUrl: normalizeBaseUrl(stored.baseUrl) ?? DEFAULTS.baseUrl,
    maxCredits:
      stored.maxCredits === undefined
        ? DEFAULTS.maxCredits
        : normalizeMaxCredits(stored.maxCredits),
    composeMode: stored.composeMode === 'add' ? 'add' : 'replace',
    fitTargetMb: normalizeTargetMb(stored.fitTargetMb),
  };
}
