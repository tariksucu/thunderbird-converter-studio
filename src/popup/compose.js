/* global messenger, document */
import { composeKey } from '../lib/jobs.js';
import {
  activeTab,
  attachmentRow,
  el,
  loadCatalog,
  privacyNote,
  send,
  setupNotice,
} from './common.js';

/**
 * The compose window's popup: the message's attachments, each with the formats Converter Studio
 * can make of it, and whether the result replaces the attachment or goes beside it.
 */

const main = document.getElementById('main');
let tab;
let catalog;
let mode = 'replace';
/** @type {Map<string, object>} */
const jobs = new Map();
/** The format picked on each row, kept when the list is drawn again. */
const choices = new Map();

function show(...nodes) {
  main.replaceChildren(...nodes);
}

async function render() {
  let attachments;
  try {
    attachments = await messenger.compose.listAttachments(tab.id);
  } catch {
    show(el('p', { className: 'notice' }, 'Open this from a message you are writing.'));
    return;
  }
  const rows = attachments.map((a) =>
    attachmentRow({
      catalog,
      name: a.name ?? 'file',
      size: a.size,
      job: jobs.get(composeKey(tab.id, a.id)),
      chosen: choices.get(composeKey(tab.id, a.id)),
      onChoose: (to) => choices.set(composeKey(tab.id, a.id), to),
      buttonText: 'Convert',
      onConvert: (to) => convert(a.id, to),
      onAnswer: (key, yes) => send({ type: 'answer', key, yes }),
      onDismiss: (key) => {
        jobs.delete(key);
        send({ type: 'dismiss', key });
        render();
      },
    }),
  );
  // A replaced attachment has a new id in the list only if Thunderbird gave it one: keep its job.
  const shown = new Set(attachments.map((a) => composeKey(tab.id, a.id)));
  const orphans = [...jobs.values()].filter(
    (job) => !shown.has(job.key) && job.state !== 'working',
  );
  for (const job of orphans)
    rows.push(
      el(
        'li',
        { className: 'attachment' },
        el('div', { className: `state ${job.state}` }, job.text),
      ),
    );

  show(
    attachments.length
      ? el('ul', { className: 'attachments' }, rows)
      : el('p', { className: 'notice' }, 'Attach a file to this message, then convert it here.'),
    el(
      'fieldset',
      { className: 'mode' },
      el('legend', {}, 'The converted file'),
      radio('replace', 'replaces the attachment'),
      radio('add', 'is attached beside it'),
    ),
    privacyNote(),
  );
}

function radio(value, text) {
  return el(
    'label',
    {},
    el('input', {
      type: 'radio',
      name: 'mode',
      value,
      checked: mode === value,
      onchange: () => {
        mode = value;
        messenger.storage.local.set({ composeMode: value });
      },
    }),
    ` ${text}`,
  );
}

async function convert(attachmentId, to) {
  const answer = await send({ type: 'compose:convert', tabId: tab.id, attachmentId, to, mode });
  if (answer?.error) {
    jobs.set(composeKey(tab.id, attachmentId), {
      key: composeKey(tab.id, attachmentId),
      state: 'error',
      text: answer.error,
    });
    render();
  }
}

messenger.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'job' || message.job.tabId !== tab?.id || message.job.kind !== 'compose')
    return;
  jobs.set(message.job.key, message.job);
  render();
});

async function start() {
  tab = await activeTab();
  const [{ composeMode }, state] = await Promise.all([
    messenger.storage.local.get('composeMode'),
    send({ type: 'state', tabId: tab.id }),
  ]);
  mode = composeMode === 'add' ? 'add' : 'replace';
  for (const job of state?.jobs ?? []) jobs.set(job.key, job);
  if (!state?.hasKey) {
    show(setupNotice(), privacyNote());
    return;
  }
  show(el('p', { className: 'muted' }, 'Loading the formats…'));
  const loaded = await loadCatalog();
  if (loaded.error) {
    show(
      el('p', { className: 'notice error', role: 'alert' }, loaded.error),
      el('button', { type: 'button', onclick: start }, 'Try again'),
    );
    return;
  }
  catalog = loaded.catalog;
  await render();
}

start();
