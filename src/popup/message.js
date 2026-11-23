/* global messenger, document */
import { messageKey } from '../lib/jobs.js';
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
 * The message window's popup: the displayed message's attachments, each with the formats
 * Converter Studio can make of it; the result is saved with Thunderbird's download settings.
 *
 * Reading a received message's attachments needs the `messagesRead` permission, and saving the
 * result needs `downloads`. Both are optional: Thunderbird asks for them the first time this
 * popup is used, so someone who only converts in the compose window never grants them.
 *
 * Thunderbird (153 and 160) prepares its message APIs for an add-on only when the add-on starts
 * with `messagesRead`: granted later, the API waits forever. So once it is granted, the background
 * page restarts the add-on (`runtime.reload`, after any running conversion), and the next click
 * on the button lists the attachments.
 */

const PERMISSIONS = { permissions: ['messagesRead', 'downloads'] };

const main = document.getElementById('main');
let tab;
let catalog;
/** @type {Map<string, object>} */
const jobs = new Map();
const choices = new Map();

function show(...nodes) {
  main.replaceChildren(...nodes);
}

function askPermission() {
  show(
    el(
      'div',
      { className: 'notice' },
      el(
        'p',
        {},
        'To convert attachments of messages you received, Converter Studio needs to read this message and save files.',
      ),
      el(
        'p',
        { className: 'muted small' },
        'Thunderbird asks you once. Nothing is read until you convert an attachment, and only that attachment is sent to Converter Studio.',
      ),
      el(
        'p',
        { className: 'actions' },
        el(
          'button',
          {
            type: 'button',
            className: 'primary',
            onclick: async () => {
              if (!(await messenger.permissions.request(PERMISSIONS))) return;
              const answer = await send({ type: 'restart-for-permissions' });
              restarting(answer?.now);
            },
          },
          'Allow',
        ),
      ),
    ),
    privacyNote(),
  );
}

/** Allowed: the add-on restarts now (this popup closes) or once its conversions are done. */
function restarting(now) {
  show(
    el(
      'p',
      { className: 'notice' },
      now
        ? 'Allowed. Converter Studio restarts to use it: click Convert again in a moment.'
        : 'Allowed. Converter Studio restarts to use it as soon as the conversions in progress are done; then click Convert again.',
    ),
  );
}

async function render() {
  let messages;
  try {
    messages = (await messenger.messageDisplay.getDisplayedMessages(tab.id)).messages ?? [];
  } catch {
    messages = [];
  }
  if (messages.length !== 1) {
    show(el('p', { className: 'notice' }, 'Open one message to convert its attachments.'));
    return;
  }
  const [message] = messages;
  const attachments = (await messenger.messages.listAttachments(message.id)).filter(
    (a) => a.contentType !== 'text/x-moz-deleted' && !a.cloudFileUrl && a.size > 0,
  );
  if (!attachments.length) {
    show(el('p', { className: 'notice' }, 'This message has no attachments to convert.'));
    return;
  }
  show(
    el(
      'ul',
      { className: 'attachments' },
      attachments.map((a) => {
        const key = messageKey(tab.id, message.id, a.partName);
        return attachmentRow({
          catalog,
          name: a.name ?? 'file',
          size: a.size,
          job: jobs.get(key),
          chosen: choices.get(key),
          onChoose: (to) => choices.set(key, to),
          buttonText: 'Convert and save',
          onConvert: (to) => convert(message.id, a, to),
          onAnswer: (k, yes) => send({ type: 'answer', key: k, yes }),
          onDismiss: (k) => {
            jobs.delete(k);
            send({ type: 'dismiss', key: k });
            render();
          },
        });
      }),
    ),
    privacyNote(),
  );
}

async function convert(messageId, attachment, to) {
  const key = messageKey(tab.id, messageId, attachment.partName);
  const answer = await send({
    type: 'message:convert',
    tabId: tab.id,
    messageId,
    partName: attachment.partName,
    name: attachment.name ?? 'file',
    to,
  });
  if (answer?.error) {
    jobs.set(key, { key, state: 'error', text: answer.error });
    render();
  }
}

messenger.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'job' || message.job.tabId !== tab?.id || message.job.kind !== 'message')
    return;
  jobs.set(message.job.key, message.job);
  if (catalog) render();
});

async function start() {
  tab = await activeTab();
  const state = await send({ type: 'state', tabId: tab.id });
  for (const job of state?.jobs ?? []) jobs.set(job.key, job);
  if (!state?.hasKey) {
    show(setupNotice(), privacyNote());
    return;
  }
  if (!(await messenger.permissions.contains(PERMISSIONS))) {
    askPermission();
    return;
  }
  if (state.restartPending) {
    restarting(false);
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
