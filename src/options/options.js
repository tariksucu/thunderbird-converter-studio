/* global messenger, document */
import { ConverterStudioClient, credits } from '../lib/client.js';
import { asConverterStudioError } from '../lib/errors.js';
import {
  DEFAULT_BASE_URL,
  loadSettings,
  normalizeBaseUrl,
  normalizeMaxCredits,
  originsFor,
} from '../lib/settings.js';

/** The options page: the API key, the credit limit and (advanced) the API's address. */

const form = document.getElementById('form');
const apiKey = document.getElementById('apiKey');
const maxCredits = document.getElementById('maxCredits');
const baseUrl = document.getElementById('baseUrl');
const status = document.getElementById('status');

function say(text, kind = '') {
  status.textContent = text;
  status.className = kind;
}

/** Links open in the system's browser. */
for (const id of ['site', 'keys', 'privacy']) {
  const link = document.getElementById(id);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    messenger.windows.openDefaultBrowser(link.href).catch(() => {});
  });
}

document.getElementById('showKey').addEventListener('change', (event) => {
  apiKey.type = event.target.checked ? 'text' : 'password';
});

/** The form's values checked; asks Thunderbird for a test server's address when one is set. */
async function readForm() {
  const url = normalizeBaseUrl(baseUrl.value || DEFAULT_BASE_URL);
  if (!url)
    throw new Error(
      'The address must be https://converter.studio/api, or a test server on localhost or 127.0.0.1.',
    );
  const origins = originsFor(url);
  // Asked here, on the Save click: Thunderbird only shows its question after a click.
  if (origins.length && !(await messenger.permissions.request({ origins })))
    throw new Error('Thunderbird was not allowed to reach that address, so it was not saved.');
  return {
    apiKey: apiKey.value.trim(),
    baseUrl: url,
    maxCredits: normalizeMaxCredits(maxCredits.value),
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const values = await readForm();
    await messenger.storage.local.set(values);
    baseUrl.value = values.baseUrl;
    maxCredits.value = String(values.maxCredits);
    say(values.apiKey ? 'Saved.' : 'Saved. Add an API key to start converting.', 'done');
  } catch (error) {
    say(error.message, 'error');
  }
});

document.getElementById('check').addEventListener('click', async () => {
  say('Checking…');
  try {
    const values = await readForm();
    if (!values.apiKey) throw new Error('Type or paste an API key first.');
    const client = new ConverterStudioClient({
      apiKey: values.apiKey,
      baseUrl: values.baseUrl,
      version: messenger.runtime.getManifest().version,
      retries: 0,
    });
    const account = await client.account();
    const allowance = account.allowance
      ? ` (${account.allowance.used} of ${account.allowance.limit} used ${account.allowance.per === 'day' ? 'today' : 'this month'})`
      : '';
    say(
      `The key works: ${account.plan} plan, ${credits(account.credits)} left${allowance}. Save to keep it.`,
      'done',
    );
  } catch (error) {
    say(asConverterStudioError(error).message, 'error');
  }
});

loadSettings(messenger.storage.local).then((settings) => {
  apiKey.value = settings.apiKey;
  maxCredits.value = String(settings.maxCredits);
  baseUrl.value = settings.baseUrl;
  if (settings.baseUrl !== DEFAULT_BASE_URL) document.getElementById('advanced').open = true;
});
