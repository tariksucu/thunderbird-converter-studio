/* global messenger */
import { ConverterStudioClient } from './lib/client.js';
import { ConverterStudioError, asConverterStudioError } from './lib/errors.js';
import { parseCatalog } from './lib/formats.js';
import { Jobs } from './lib/jobs.js';
import { loadSettings } from './lib/settings.js';

/**
 * The background page: it runs the conversions (lib/jobs.js) for the two popups, keeps the
 * toolbar buttons' badges, and stays awake while a conversion runs. It stores nothing but the
 * settings (options page) and a copy of the API's format list.
 */

const VERSION = messenger.runtime.getManifest().version;
/** The format list is fetched again after a day (it changes when Converter Studio adds formats). */
const CATALOG_MAX_AGE_MS = 24 * 3600 * 1000;
/** Thunderbird ends an idle background page after 30 s; a call to it every 15 s keeps it working. */
const KEEP_AWAKE_MS = 15_000;

const makeClient = (settings) =>
  new ConverterStudioClient({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    version: VERSION,
  });

let catalogCache = null;

/** The API's format list: from memory, from `storage.local` when younger than a day, or fetched. */
async function catalogFor(client) {
  if (
    catalogCache &&
    catalogCache.baseUrl === client.baseUrl &&
    Date.now() - catalogCache.at < CATALOG_MAX_AGE_MS
  )
    return catalogCache.catalog;
  const { formatsCache } = await messenger.storage.local.get('formatsCache');
  if (
    formatsCache?.baseUrl === client.baseUrl &&
    Date.now() - formatsCache.at < CATALOG_MAX_AGE_MS
  ) {
    catalogCache = { ...formatsCache, catalog: parseCatalog(formatsCache.body) };
    return catalogCache.catalog;
  }
  try {
    const body = await client.formats();
    const catalog = parseCatalog(body);
    if (!catalog.formats.length) throw new ConverterStudioError('notJson');
    catalogCache = { baseUrl: client.baseUrl, at: Date.now(), body, catalog };
    await messenger.storage.local.set({
      formatsCache: { baseUrl: client.baseUrl, at: catalogCache.at, body },
    });
    return catalog;
  } catch (error) {
    // An older copy is better than nothing while the API cannot be reached.
    if (formatsCache?.baseUrl === client.baseUrl) return parseCatalog(formatsCache.body);
    throw error;
  }
}

/** A name Thunderbird accepts for a file on disk. */
function diskName(name) {
  const cleaned = [...String(name)]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned || 'converted';
}

/** Resolves with the download once it is complete; rejects when it fails or is canceled. */
function downloadDone(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new ConverterStudioError('saveFailed')), 10 * 60_000);
    const check = async () => {
      const [item] = await messenger.downloads.search({ id });
      if (item?.state === 'complete') finish(null, item);
      else if (item?.state === 'interrupted')
        finish(
          new ConverterStudioError('saveFailed', `Not saved (${item.error ?? 'interrupted'}).`),
        );
    };
    const listener = (delta) => {
      if (delta.id === id && delta.state) check().catch(() => {});
    };
    function finish(error, item) {
      clearTimeout(timer);
      messenger.downloads.onChanged.removeListener(listener);
      if (error) reject(error);
      else resolve(item);
    }
    messenger.downloads.onChanged.addListener(listener);
    check().catch(() => {});
  });
}

/**
 * Saves a converted file with Thunderbird's own download settings ("Save files to" or "Always
 * ask me where to save files"); returns where it went.
 */
async function save(file) {
  const url = URL.createObjectURL(file);
  try {
    const id = await messenger.downloads.download({
      url,
      filename: diskName(file.name),
      conflictAction: 'uniquify',
    });
    const item = await downloadDone(id);
    return item.filename;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

const jobs = new Jobs({
  compose: messenger.compose,
  messages: {
    getAttachmentFile: (messageId, partName) =>
      messenger.messages.getAttachmentFile(messageId, partName),
  },
  save,
  settings: () => loadSettings(messenger.storage.local),
  client: makeClient,
  catalog: catalogFor,
  onChange: (job) => {
    messenger.runtime.sendMessage({ type: 'job', job }).catch(() => {});
    updateBadge(job.kind, job.tabId);
    keepAwake();
    if (restartPending && !jobs.busy) restartSoon();
  },
});

/**
 * Thunderbird prepares its message APIs for an add-on when the add-on starts with `messagesRead`
 * (ext-mail.js, "startup"); granted later, they never answer. After the message popup's "Allow",
 * the add-on restarts once, as soon as no conversion runs.
 */
let restartPending = false;
let restartScheduled = false;
function restartSoon() {
  restartPending = true;
  if (restartScheduled) return;
  restartScheduled = true;
  // A moment for the popup to say so before it closes with the restart.
  setTimeout(() => messenger.runtime.reload(), 1500);
}

/** The number of running conversions on the tab's toolbar button. */
function updateBadge(kind, tabId) {
  const action = kind === 'compose' ? messenger.composeAction : messenger.messageDisplayAction;
  const n = jobs.running(tabId);
  action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}

let awakeTimer = null;
/** While a conversion runs, a call to Thunderbird now and then keeps this page from being ended. */
function keepAwake() {
  if (jobs.busy && !awakeTimer) {
    awakeTimer = setInterval(() => {
      if (!jobs.busy) {
        clearInterval(awakeTimer);
        awakeTimer = null;
        return;
      }
      messenger.runtime.getPlatformInfo().catch(() => {});
    }, KEEP_AWAKE_MS);
  }
}

/** Starts a job and answers at once; the job reports itself through `onChange`. */
function begin(start) {
  try {
    start().catch(() => {});
    return { ok: true };
  } catch (error) {
    return { error: asConverterStudioError(error).message };
  }
}

async function handle(message) {
  switch (message?.type) {
    case 'state':
      return {
        jobs: jobs.list(message.tabId),
        hasKey: Boolean((await loadSettings(messenger.storage.local)).apiKey),
        restartPending,
      };
    case 'restart-for-permissions':
      if (jobs.busy) {
        restartPending = true;
        return { now: false };
      }
      restartSoon();
      return { now: true };
    case 'catalog': {
      const settings = await loadSettings(messenger.storage.local);
      try {
        return { formats: (await catalogFor(makeClient(settings))).formats };
      } catch (error) {
        return { error: asConverterStudioError(error).message };
      }
    }
    case 'compose:convert':
      return begin(() => jobs.convertComposeAttachment(message));
    case 'message:convert':
      return begin(() => jobs.convertMessageAttachment(message));
    case 'answer':
      return { ok: jobs.answer(message.key, message.yes) };
    case 'dismiss':
      jobs.dismiss(message.key);
      return { ok: true };
    default:
      return undefined;
  }
}

messenger.runtime.onMessage.addListener((message, sender) => {
  // Only this add-on's own pages talk to it.
  if (sender.id !== messenger.runtime.id) return undefined;
  return handle(message);
});

messenger.tabs.onRemoved.addListener((tabId) => jobs.forgetTab(tabId));

// A new address or key may mean other formats: fetch the list again next time.
messenger.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.baseUrl || changes.apiKey)) catalogCache = null;
});
