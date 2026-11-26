import { credits } from './client.js';
import { ConverterStudioError, ERROR_TEXT, asConverterStudioError } from './errors.js';
import {
  MB_BYTES,
  attachments,
  formatMb,
  largestOver,
  normalizeTargetMb,
  serverFit,
  shares,
  summaryLine,
  whereItFits,
} from './fit.js';
import { outputName } from './formats.js';
import { sniff } from './photos.js';

/**
 * "Fit attachments for sending": brings the attachments of the message being written under a
 * total size, the cheapest way first, and replaces them in place (same names and order; a new
 * extension only when the type changes, HEIC to JPG):
 *
 * 1. Already under the target: nothing changes.
 * 2. Photos are made smaller on this computer (lib/photos.js), free and with no key: largest
 *    first, the first step only until the total fits; smaller steps only while that alone can
 *    make it fit.
 * 3. What still does not fit and needs Converter Studio's server (a PDF, a video, a sound, a
 *    photo this computer cannot read) is sent there, only with the user's API key, each within
 *    its share of what is left. The price comes first (`maxCredits: 0`), and nothing is charged
 *    unless the user goes ahead. Without a key, those attachments are named with what a key
 *    would do. An MP4 stays an MP4 and an MP3 an MP3 (same name); one the server cannot make
 *    smaller comes back as it was (`notSmaller`), costs nothing and stays as it is.
 *
 * An attachment is replaced only once its smaller copy is ready; when anything fails, it stays
 * as it was. One fit at a time per compose window. Everything Thunderbird-specific comes in
 * through `deps`, so the tests run it with fakes.
 */

const ACTIVE = new Set(['working', 'quoted']);
/**
 * The first step replaces a photo only when that saves at least this share of it: a photo made
 * small before (by a fit, or already sent that way) is not saved again for nothing.
 */
const FIRST_STEP_GAIN = 0.05;
/**
 * About how small the smallest step (1280 px, the lowest quality) leaves a photo after the first
 * step (2048 px), on the low side: a third of the pixels, and for a JPEG a lower quality too.
 * Below this the smaller steps are not tried, since they could not make it fit.
 */
const SMALLEST = { jpeg: 0.12, heic: 0.12, webp: 0.12, png: 0.25 };

/** Shown when something is still too big: Thunderbird's own way to send large files. */
export const FILELINK_HINT =
  "Thunderbird's Filelink can send large files as links instead (Settings → Composition → Attachments).";

/**
 * @typedef {{
 *   tabId: number, targetMb: number, state: 'working' | 'quoted' | 'done' | 'error',
 *   text: string, progress: number | null, credits?: number, lines: string[],
 *   keyLine?: string, fits?: boolean
 * }} Fit
 */

const total = (items) => items.reduce((sum, item) => sum + (item.size ?? 0), 0);

/** "report.pdf and clip.mov → clip.mp4". */
function namesOf(list) {
  const names = list.map(({ item, newName }) =>
    newName && newName !== item.name ? `${item.name} → ${newName}` : item.name,
  );
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}

/** "Already as small as it gets, so kept as it was (nothing charged): song.mp3." */
function keptLine(list) {
  const one = list.length === 1;
  return (
    `Already as small as ${one ? 'it gets' : 'they get'}, so kept as ${one ? 'it was' : 'they were'} ` +
    `(nothing charged): ${namesOf(list)}.`
  );
}

export class Fitter {
  /**
   * @param {{
   *   compose: { listAttachments(tabId: number): Promise<any[]>, getAttachmentFile(id: number): Promise<File>,
   *              updateAttachment(tabId: number, id: number, a: object): Promise<any> },
   *   photos: { read(file: File, kind: string): Promise<object>, shrink(photo: object, target: object): Promise<object | null>,
   *             release(photo: object): void },
   *   settings: () => Promise<{ apiKey: string, baseUrl: string }>,
   *   client: (settings: object) => import('./client.js').ConverterStudioClient,
   *   catalog: (client: import('./client.js').ConverterStudioClient) => Promise<import('./formats.js').Catalog>,
   *   onChange?: (fit: Fit) => void,
   *   timeoutMs?: number,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<number, Fit>} */
    this.fits = new Map();
    /** The go-ahead a priced fit waits for: tabId → resolve(true | false). */
    this.answers = new Map();
  }

  /** A tab's fit, for its popup. */
  get(tabId) {
    const fit = this.fits.get(tabId);
    return fit ? { ...fit, lines: [...fit.lines] } : undefined;
  }

  /** Whether a fit runs (or waits for a go-ahead) in the tab. */
  active(tabId) {
    return ACTIVE.has(this.fits.get(tabId)?.state);
  }

  /** Whether any fit still runs (the background page must stay awake for it). */
  get busy() {
    return [...this.fits.values()].some((fit) => ACTIVE.has(fit.state));
  }

  /** The tab is gone: a waiting price is turned down, a finished fit forgotten. */
  forgetTab(tabId) {
    this.answer(tabId, false);
    if (!this.active(tabId)) this.fits.delete(tabId);
  }

  /** Forgets a finished fit (the popup's "dismiss"). */
  dismiss(tabId) {
    if (!this.active(tabId)) this.fits.delete(tabId);
  }

  /** The go-ahead for the server's price, or not. */
  answer(tabId, yes) {
    const resolve = this.answers.get(tabId);
    if (!resolve) return false;
    this.answers.delete(tabId);
    resolve(Boolean(yes));
    return true;
  }

  /** Starts fitting the attachments of the message in `tabId` under `targetMb`. */
  start({ tabId, targetMb }) {
    if (this.active(tabId))
      throw new ConverterStudioError('busy', 'The attachments are already being fitted.');
    /** @type {Fit} */
    const fit = {
      tabId,
      targetMb: normalizeTargetMb(targetMb),
      state: 'working',
      text: '',
      progress: null,
      lines: [],
    };
    this.fits.set(tabId, fit);
    this.update(fit, 'Reading the attachments…');
    return this.execute(fit);
  }

  async execute(fit) {
    try {
      await this.work(fit);
    } catch (error) {
      this.finish(fit, { state: 'error', text: asConverterStudioError(error).message });
    } finally {
      this.answers.delete(fit.tabId);
    }
    return fit;
  }

  async work(fit) {
    const target = fit.targetMb * MB_BYTES;
    const listed = await this.list(fit.tabId);
    if (!listed.length) return this.finish(fit, { text: 'Attach files to this message first.' });
    const before = total(listed);
    if (before <= target) {
      return this.finish(fit, {
        fits: true,
        text: `Already fits: ${attachments(listed.length)}, ${formatMb(before)}. ${whereItFits(before)}`,
      });
    }
    const items = listed.map((a) => ({ id: a.id, name: a.name ?? 'file', size: a.size ?? 0 }));
    for (const item of items) {
      // As listed: an attachment changed meanwhile is not replaced.
      item.listed = item.size;
      try {
        item.file = await this.deps.compose.getAttachmentFile(item.id);
        item.kind = sniff(new Uint8Array(await item.file.slice(0, 64).arrayBuffer()));
      } catch {
        // Not a file on this computer (part of a forwarded message): it stays as it is.
        item.file = null;
        item.kind = null;
      }
    }

    await this.photos(fit, items, target);
    for (const item of items) if (item.result && !item.replaced) await this.replace(fit, item);
    if (total(items) > target) await this.server(fit, items, target);

    const now = await this.list(fit.tabId);
    const after = total(now);
    const lines = [...fit.lines];
    if (after > target) {
      const big = largestOver(now, target).map((a) => `${a.name} (${formatMb(a.size)})`);
      lines.push(`Too big to fit: ${big.join(', ')}. ${FILELINK_HINT}`);
    }
    // What the server handed back as it was is said in the outcome's line: kept, not failed.
    const kept = items.filter((item) => item.kept).map((item) => ({ item }));
    const summary = summaryLine({ count: now.length, before, after, targetMb: fit.targetMb });
    return this.finish(fit, {
      fits: after <= target,
      text: kept.length ? `${summary} ${keptLine(kept)}` : summary,
      lines,
    });
  }

  /** Step 2: the photos, on this computer. */
  async photos(fit, items, target) {
    const photos = items.filter((item) => item.kind).sort((a, b) => b.size - a.size);
    // First step (2048 px, quality 0.85), largest first, until the total fits.
    let n = 0;
    for (const item of photos) {
      if (total(items) <= target) return;
      this.update(fit, `Making photos smaller on this computer… ${++n} of ${photos.length}`);
      await this.shrinkLocally(item, null);
    }
    // Smaller steps, only while the photos alone can make it fit: not when even their smallest
    // copies would leave it over (a PDF or a video is the problem; the photos stay as they are).
    const ready = photos.filter((item) => !item.unreadable);
    const budget = target - total(items.filter((item) => !ready.includes(item)));
    const smallest = ready.reduce((sum, item) => sum + item.size * SMALLEST[item.kind], 0);
    if (total(items) <= target || budget <= 0 || !ready.length || smallest > budget) return;
    const share = shares(
      ready.map((item) => item.size),
      budget,
    );
    const over = ready.filter((item, k) => item.size > share[k]);
    for (const [k, item] of over.entries()) {
      this.update(fit, `Making photos smaller on this computer… ${k + 1} of ${over.length}`);
      await this.shrinkLocally(item, share[ready.indexOf(item)]);
    }
  }

  /** One photo, from its original file each time (never a copy of a copy). */
  async shrinkLocally(item, share) {
    let photo = null;
    try {
      photo = await this.deps.photos.read(item.file, item.kind);
      const result = await this.deps.photos.shrink(photo, {
        name: item.name,
        size: item.size,
        share,
      });
      const enough = share === null ? item.size * (1 - FIRST_STEP_GAIN) : item.size;
      if (result && result.blob.size < enough) {
        item.result = result;
        item.size = result.blob.size;
      }
    } catch {
      // This computer cannot read it: Converter Studio's server may (step 3).
      if (!item.result) item.unreadable = true;
    } finally {
      if (photo) this.deps.photos.release(photo);
    }
  }

  /** Step 3: what needs Converter Studio's server, with the user's key and go-ahead. */
  async server(fit, items, target) {
    const candidates = items.filter(
      (item) => item.file && !item.replaced && (!item.kind || item.unreadable),
    );
    if (!candidates.length) return;
    const settings = await this.deps.settings();
    const client = this.deps.client(settings);
    let catalog;
    try {
      catalog = await this.deps.catalog(client);
    } catch (error) {
      fit.lines.push(
        `The other attachments were not made smaller: ${asConverterStudioError(error).message}`,
      );
      return;
    }
    const plans = candidates.filter((item) => serverFit(catalog, item.name, Infinity));
    // What the other attachments leave, shared among these; if they leave nothing, it cannot fit.
    const budget = target - total(items.filter((item) => !plans.includes(item)));
    if (!plans.length || budget <= 0) return;
    const share = shares(
      plans.map((item) => item.size),
      budget,
    );
    const send = plans
      .map((item, k) => {
        const plan = serverFit(catalog, item.name, share[k]);
        const newName = plan.to === plan.from ? item.name : outputName(catalog, item.name, plan.to);
        return { item, plan, newName };
      })
      .filter(({ item }, k) => item.size > share[k]);
    if (!send.length) return;

    if (!settings.apiKey) {
      const them = send.length === 1 ? 'it is' : 'they are';
      fit.keyLine =
        `${namesOf(send.map(({ item }) => ({ item })))} ${send.length === 1 ? 'needs' : 'need'} ` +
        `Converter Studio's server: with an API key, ${them} made smaller there, and you see the price first.`;
      return;
    }

    // The price of each, without charging anything (maxCredits 0 only prices a conversion).
    const priced = [];
    for (const [k, entry] of send.entries()) {
      this.update(fit, `Asking Converter Studio for the price… ${k + 1} of ${send.length}`);
      try {
        const upload = await client.upload(entry.item.file, entry.item.name);
        const view = await client.settle(
          await client.start({
            uploadId: upload.id,
            to: entry.plan.to,
            options: entry.plan.options,
            maxCredits: 0,
          }),
          { timeoutMs: this.deps.timeoutMs },
        );
        if (view.status === 'quoted' || view.status === 'done') priced.push({ ...entry, view });
        else fit.lines.push(`${entry.item.name}: ${failure(view).message}`);
      } catch (error) {
        const e = asConverterStudioError(error);
        fit.lines.push(`${entry.item.name}: ${e.message}`);
        // The others would fail alike.
        if (e.code === 'invalidApiKey' || e.status === 401) break;
      }
    }
    if (!priced.length) return;

    const quoted = priced.filter(({ view }) => view.status === 'quoted');
    if (quoted.length) {
      const price = quoted.reduce((sum, { view }) => sum + (view.credits ?? 0), 0);
      this.set(fit, {
        state: 'quoted',
        credits: price,
        progress: null,
        text: `Converter Studio can make ${namesOf(priced)} smaller for ${credits(price)}.`,
      });
      const yes = await new Promise((resolve) => this.answers.set(fit.tabId, resolve));
      this.set(fit, { state: 'working', credits: undefined });
      if (!yes) {
        fit.lines.push(
          `Not sent for conversion, so nothing was charged: ${namesOf(priced.map(({ item }) => ({ item })))}.`,
        );
        return;
      }
    }

    for (const [k, entry] of priced.entries()) {
      const step = `${k + 1} of ${priced.length}`;
      this.update(fit, `Making ${entry.item.name} smaller at Converter Studio… ${step}`);
      try {
        let view = entry.view;
        if (view.status === 'quoted') {
          view = await client.settle(await client.confirm(view.id), {
            timeoutMs: this.deps.timeoutMs,
            onProgress: (v) =>
              this.update(
                fit,
                `Making ${entry.item.name} smaller at Converter Studio… ${step}`,
                v.status === 'processing' ? v.progress : null,
              ),
          });
        }
        if (view.status !== 'done' || !view.downloadUrl) throw failure(view);
        // The server could not make it smaller: its result is the upload itself, free. The
        // attachment stays as it is (nothing to download).
        if (view.notSmaller === true) {
          entry.item.kept = true;
          continue;
        }
        this.update(fit, `Downloading ${entry.newName}… ${step}`);
        const { blob, type } = await client.download(view.downloadUrl);
        // Servers before 2026-11-26 say nothing of `notSmaller`: the size tells.
        if (blob.size >= entry.item.size) {
          fit.lines.push(`${entry.item.name} did not get smaller, so it was kept.`);
          continue;
        }
        entry.item.result = { blob, type, name: entry.newName };
        entry.item.size = blob.size;
        await this.replace(fit, entry.item);
      } catch (error) {
        fit.lines.push(`${entry.item.name}: ${asConverterStudioError(error).message}`);
      }
    }
  }

  /** Puts an attachment's smaller copy in its place, if the attachment is still as it was read. */
  async replace(fit, item) {
    const now = (await this.list(fit.tabId)).find((a) => a.id === item.id);
    if (!now || (now.size ?? 0) !== item.listed) {
      fit.lines.push(`${item.name} was changed or removed meanwhile, so it was left alone.`);
      item.size = now?.size ?? 0;
      return;
    }
    const { blob, name, type } = item.result;
    try {
      await this.deps.compose.updateAttachment(fit.tabId, item.id, {
        file: new File([blob], name, { type }),
        name,
      });
      item.replaced = true;
    } catch {
      fit.lines.push(`${item.name}: ${ERROR_TEXT.attachFailed}`);
      item.size = item.listed;
    }
  }

  async list(tabId) {
    try {
      return await this.deps.compose.listAttachments(tabId);
    } catch {
      throw new ConverterStudioError(
        'composeGone',
        'The message window was closed, so its attachments were not changed.',
      );
    }
  }

  update(fit, text, progress = null) {
    this.set(fit, { text, progress: typeof progress === 'number' ? progress : null });
  }

  set(fit, fields) {
    Object.assign(fit, fields);
    this.deps.onChange?.({ ...fit, lines: [...fit.lines] });
  }

  finish(fit, fields) {
    this.set(fit, { state: 'done', progress: null, ...fields });
  }
}

/** Why a conversion the API settled did not end with a file. */
function failure(view) {
  const code = view.status === 'expired' ? 'fileExpired' : (view.error?.code ?? 'conversionFailed');
  return new ConverterStudioError(code, view.error?.message ?? ERROR_TEXT[code]);
}
