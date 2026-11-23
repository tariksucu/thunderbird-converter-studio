/* global messenger, document */
import { credits } from '../lib/client.js';
import { defaultTarget, formatBytes, formatOf, parseCatalog, targetsFor } from '../lib/formats.js';

/** Helpers both popups use. Pages are built with DOM calls only (no innerHTML). */

export const ACCOUNT_URL = 'https://converter.studio/account#api-keys';
export const PRIVACY_URL = 'https://converter.studio/privacy';

/** An element with attributes, event handlers (`onclick`…) and children (strings become text). */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'className') node.className = value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** A link that opens in the system's browser, as Thunderbird does for links in messages. */
export function externalLink(href, text) {
  return el(
    'a',
    {
      href,
      onclick: (event) => {
        event.preventDefault();
        messenger.windows.openDefaultBrowser(href).catch(() => {});
      },
    },
    text,
  );
}

export const send = (message) => messenger.runtime.sendMessage(message);

/** The tab whose toolbar button opened this popup. */
export async function activeTab() {
  const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** The format list from the background page, as a catalogue (or an error message). */
export async function loadCatalog() {
  const answer = await send({ type: 'catalog' });
  if (!answer || answer.error)
    return { error: answer?.error ?? 'Converter Studio could not be reached.' };
  return { catalog: parseCatalog({ formats: answer.formats }) };
}

/** "Add your API key first" with a way to the options page and to the key page. */
export function setupNotice() {
  return el(
    'div',
    { className: 'notice', role: 'status' },
    el('p', {}, 'Add your Converter Studio API key to start converting.'),
    el(
      'p',
      { className: 'actions' },
      el(
        'button',
        { type: 'button', onclick: () => messenger.runtime.openOptionsPage() },
        'Open the options',
      ),
      ' ',
      externalLink(ACCOUNT_URL, 'Get a key'),
    ),
  );
}

/** One line per attachment: name and size, a format list, a button and the job's state. */
export function attachmentRow({
  catalog,
  name,
  size,
  job,
  chosen,
  onChoose,
  buttonText,
  onConvert,
  onAnswer,
  onDismiss,
}) {
  const from = formatOf(catalog, name);
  const targets = targetsFor(catalog, from);
  const busy = job && (job.state === 'working' || job.state === 'quoted');
  const row = el('li', { className: 'attachment', 'data-name': name });
  row.append(
    el(
      'div',
      { className: 'file' },
      el('span', { className: 'name', title: name }, name),
      el('span', { className: 'size' }, formatBytes(size)),
    ),
  );
  if (!targets.length) {
    row.append(
      el('p', { className: 'muted' }, 'Converter Studio does not convert this kind of file.'),
    );
  } else {
    const select = el(
      'select',
      {
        'aria-label': `Convert ${name} to`,
        disabled: busy,
        onchange: () => onChoose?.(select.value),
      },
      targets.map((t) => el('option', { value: t.to }, t.label)),
    );
    const known = (to) => to && targets.some((t) => t.to === to);
    select.value = known(chosen) ? chosen : known(job?.to) ? job.to : defaultTarget(catalog, from);
    row.append(
      el(
        'div',
        { className: 'controls' },
        el('label', {}, 'to ', select),
        el(
          'button',
          {
            type: 'button',
            className: 'primary',
            disabled: busy,
            onclick: () => onConvert(select.value),
          },
          buttonText,
        ),
      ),
    );
  }
  if (job) row.append(jobState(job, { onAnswer, onDismiss }));
  return row;
}

/** A job's progress, its outcome, or the go-ahead it waits for. */
function jobState(job, { onAnswer, onDismiss }) {
  const box = el(
    'div',
    { className: `state ${job.state}`, role: job.state === 'error' ? 'alert' : 'status' },
    el('span', {}, job.text),
  );
  if (job.state === 'working' && job.phase === 'processing' && typeof job.progress === 'number') {
    box.append(el('progress', { max: '100', value: String(Math.round(job.progress * 100)) }));
  } else if (job.state === 'working') {
    box.append(el('progress', {}));
  }
  if (job.state === 'quoted') {
    box.append(
      el(
        'p',
        { className: 'actions' },
        el(
          'button',
          { type: 'button', className: 'primary', onclick: () => onAnswer(job.key, true) },
          `Convert for ${credits(job.credits)}`,
        ),
        ' ',
        el('button', { type: 'button', onclick: () => onAnswer(job.key, false) }, 'Cancel'),
      ),
    );
  }
  if (job.state === 'done' || job.state === 'error') {
    box.append(
      el(
        'button',
        {
          type: 'button',
          className: 'link',
          'aria-label': 'Dismiss',
          onclick: () => onDismiss(job.key),
        },
        '×',
      ),
    );
  }
  return box;
}

/** "Files are sent to converter.studio…" with the privacy policy. */
export function privacyNote() {
  return el(
    'p',
    { className: 'muted small' },
    'Only the attachments you convert are sent to Converter Studio. It deletes them when the conversion finishes, and the result after 6 hours. ',
    externalLink(PRIVACY_URL, 'Privacy policy'),
  );
}
