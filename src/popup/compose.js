/* global messenger, document */
import { credits } from '../lib/client.js';
import { FIT_TARGETS, attachments, formatMb, normalizeTargetMb } from '../lib/fit.js';
import { composeKey } from '../lib/jobs.js';
import {
  ACCOUNT_URL,
  activeTab,
  attachmentRow,
  el,
  externalLink,
  loadCatalog,
  privacyNote,
  send,
  setupNotice,
} from './common.js';

/**
 * The compose window's popup. At the top, "Fit attachments for sending": all the attachments
 * brought under 16 MB (or 10 MB), photos on this computer without a key, the rest with
 * Converter Studio's server after its price (lib/fitter.js, in the background page). Below,
 * each attachment with the formats Converter Studio can make of it, and whether the result
 * replaces the attachment or goes beside it.
 */

const main = document.getElementById('main');
let tab;
let catalog = null;
/** Why the format list could not be loaded (the fit works without it). */
let catalogError = null;
let hasKey = false;
let mode = 'replace';
let targetMb = 16;
/** The tab's fit, as the background page last told it. */
let fit = null;
/** @type {Map<string, object>} */
const jobs = new Map();
/** The format picked on each row, kept when the list is drawn again. */
const choices = new Map();

const ACTIVE = new Set(['working', 'quoted']);

function show(...nodes) {
  main.replaceChildren(...nodes);
}

async function render() {
  let list;
  try {
    list = await messenger.compose.listAttachments(tab.id);
  } catch {
    show(el('p', { className: 'notice' }, 'Open this from a message you are writing.'));
    return;
  }
  const fitting = ACTIVE.has(fit?.state);
  const converting = [...jobs.values()].some((job) => ACTIVE.has(job.state));
  let convertPart;
  if (!hasKey) {
    convertPart = setupNotice(
      'To convert an attachment to another format (Word to PDF, a video to MP4…), ' +
        'add your Converter Studio API key.',
    );
  } else if (catalogError) {
    convertPart = el(
      'div',
      {},
      el('p', { className: 'notice error', role: 'alert' }, catalogError),
      el('button', { type: 'button', onclick: start }, 'Try again'),
    );
  } else if (!catalog) {
    convertPart = el('p', { className: 'muted' }, 'Loading the formats…');
  } else {
    convertPart = convertSection(list, fitting);
  }
  show(
    fitSection(list, { fitting, converting }),
    convertPart,
    privacyNote(
      'Only what you convert, or fit with your API key, is sent to Converter Studio. It deletes ' +
        'it when the conversion finishes (or 30 minutes after a price you cancel), and the ' +
        'result after 6 hours. ',
    ),
  );
}

/** "Fit attachments for sending", its target, and the fit's progress or outcome. */
function fitSection(list, { fitting, converting }) {
  const size = list.reduce((sum, a) => sum + (a.size ?? 0), 0);
  const select = el(
    'select',
    {
      id: 'fit-target',
      'aria-label': 'Fit under',
      disabled: fitting,
      onchange: () => {
        targetMb = normalizeTargetMb(select.value);
        messenger.storage.local.set({ fitTargetMb: targetMb });
      },
    },
    FIT_TARGETS.map((t) => el('option', { value: String(t.mb) }, t.label)),
  );
  select.value = String(targetMb);
  return el(
    'section',
    { className: 'fit' },
    el(
      'p',
      { className: 'muted' },
      list.length
        ? `${attachments(list.length)}, ${formatMb(size)} in all.`
        : 'No attachments yet.',
    ),
    el(
      'div',
      { className: 'controls' },
      el(
        'button',
        {
          type: 'button',
          id: 'fit',
          className: 'primary',
          disabled: fitting || converting || !list.length,
          onclick: startFit,
        },
        'Fit attachments for sending',
      ),
      el('label', {}, 'under ', select),
    ),
    fit ? fitState(fit) : null,
    el(
      'p',
      { className: 'muted small' },
      'Photos are made smaller on this computer, free and with no key; they lose their ' +
        'metadata (date, camera, location). With your API key, a PDF, video or sound that ' +
        'still does not fit goes to Converter Studio, which shows the price first.',
    ),
  );
}

/** The fit's progress, the price it waits for, or its outcome. */
function fitState(f) {
  const kind = f.state === 'done' ? (f.fits ? 'done' : 'over') : f.state;
  const box = el(
    'div',
    { className: `state fit-state ${kind}`, role: f.state === 'error' ? 'alert' : 'status' },
    el('span', {}, f.text),
  );
  if (f.state === 'working')
    box.append(
      typeof f.progress === 'number'
        ? el('progress', { max: '100', value: String(Math.round(f.progress * 100)) })
        : el('progress', {}),
    );
  if (f.state === 'quoted') {
    box.append(
      el(
        'p',
        { className: 'actions' },
        el(
          'button',
          { type: 'button', className: 'primary', onclick: () => answer(true) },
          `Fit for ${credits(f.credits)}`,
        ),
        ' ',
        el('button', { type: 'button', onclick: () => answer(false) }, 'Cancel'),
      ),
    );
  }
  if (f.state === 'done' || f.state === 'error') {
    box.append(
      el(
        'button',
        {
          type: 'button',
          className: 'link',
          'aria-label': 'Dismiss',
          onclick: () => {
            fit = null;
            send({ type: 'fit:dismiss', tabId: tab.id });
            render();
          },
        },
        '×',
      ),
    );
  }
  const lines = (f.lines ?? []).map((line) => el('p', { className: 'line' }, line));
  // What a key would do, with the way to one.
  if (f.keyLine)
    lines.unshift(
      el('p', { className: 'line' }, `${f.keyLine} `, externalLink(ACCOUNT_URL, 'Get an API key')),
    );
  return el('div', { className: 'fit-result' }, box, lines);
}

/** Each attachment with its formats, and where the converted file goes. */
function convertSection(list, fitting) {
  const rows = list.map((a) =>
    attachmentRow({
      catalog,
      name: a.name ?? 'file',
      size: a.size,
      job: jobs.get(composeKey(tab.id, a.id)),
      chosen: choices.get(composeKey(tab.id, a.id)),
      locked: fitting,
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
  const shown = new Set(list.map((a) => composeKey(tab.id, a.id)));
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
  return el(
    'section',
    { className: 'convert' },
    el('h2', {}, 'Convert one attachment'),
    list.length
      ? el('ul', { className: 'attachments' }, rows)
      : el('p', { className: 'notice' }, 'Attach a file to this message, then convert it here.'),
    el(
      'fieldset',
      { className: 'mode' },
      el('legend', {}, 'The converted file'),
      radio('replace', 'replaces the attachment'),
      radio('add', 'is attached beside it'),
    ),
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

async function startFit() {
  const answered = await send({ type: 'fit:start', tabId: tab.id, targetMb });
  if (answered?.error) {
    fit = { tabId: tab.id, state: 'error', text: answered.error, lines: [] };
    render();
  }
}

function answer(yes) {
  send({ type: 'fit:answer', tabId: tab.id, yes });
}

async function convert(attachmentId, to) {
  const answered = await send({ type: 'compose:convert', tabId: tab.id, attachmentId, to, mode });
  if (answered?.error) {
    jobs.set(composeKey(tab.id, attachmentId), {
      key: composeKey(tab.id, attachmentId),
      state: 'error',
      text: answered.error,
    });
    render();
  }
}

messenger.runtime.onMessage.addListener((message) => {
  if (message?.type === 'fit' && message.fit.tabId === tab?.id) {
    fit = message.fit;
    render();
  } else if (message?.type === 'job' && message.job.tabId === tab?.id) {
    if (message.job.kind !== 'compose') return;
    jobs.set(message.job.key, message.job);
    render();
  }
});

async function start() {
  tab = await activeTab();
  const [stored, state] = await Promise.all([
    messenger.storage.local.get(['composeMode', 'fitTargetMb']),
    send({ type: 'state', tabId: tab.id }),
  ]);
  mode = stored.composeMode === 'add' ? 'add' : 'replace';
  targetMb = normalizeTargetMb(stored.fitTargetMb);
  fit = state?.fit ?? null;
  hasKey = Boolean(state?.hasKey);
  for (const job of state?.jobs ?? []) jobs.set(job.key, job);
  catalogError = null;
  await render();
  if (hasKey) {
    const loaded = await loadCatalog();
    catalog = loaded.catalog ?? null;
    catalogError = loaded.error ?? null;
    await render();
  }
}

start();
