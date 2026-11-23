/**
 * Why a conversion did not happen, as a fixed list of codes. The text shown to the user is the
 * API's own `error.message` when the API sent one, and the plain-English words below otherwise.
 */

/** Words for the add-on's own codes, and fallbacks for the API's when it sent no message. */
export const ERROR_TEXT = {
  // The add-on's own.
  notConfigured: 'Add your Converter Studio API key in the add-on options first.',
  badBaseUrl:
    'The Converter Studio address must be https://converter.studio/api (or a local test server).',
  noPermission:
    'Thunderbird has not allowed the add-on to reach this address. Save the options again and allow it.',
  network: 'Converter Studio could not be reached. Check the connection and try again.',
  timeout: 'The conversion did not finish in time. It may still finish at Converter Studio.',
  notJson: 'Converter Studio sent an answer the add-on cannot read. Try again in a minute.',
  unknownFormat: 'Converter Studio does not read this kind of file.',
  sourceEmpty: 'The attachment is empty.',
  sourceUnreadable: 'Thunderbird could not read the attachment.',
  uploadIncomplete: 'The upload to Converter Studio did not arrive whole. Try again.',
  foreignLink: 'Converter Studio sent a link to another address; it was not followed.',
  resultDownloadFailed: 'The converted file could not be downloaded from Converter Studio.',
  overMaxCredits: 'This conversion costs more credits than allowed in the options.',
  composeGone: 'The message window was closed, so the converted file could not be attached.',
  attachmentGone: 'The attachment was removed from the message while it was converted.',
  attachFailed: 'Thunderbird could not attach the converted file.',
  saveFailed: 'Thunderbird could not save the converted file.',
  notSmaller: 'The PDF could not be made smaller, so the original was kept.',
  busy: 'This attachment is already being converted.',
  // The API's (`{ error: { code, message } }`), for answers without a message.
  invalidApiKey: 'The Converter Studio API key does not work (wrong or deleted).',
  notEnoughCredits: 'Not enough credits left on the Converter Studio account.',
  dailyLimit: "The Converter Studio account's daily credits are used up.",
  monthlyLimit: "The Converter Studio account's monthly credits are used up.",
  fileTooLarge: 'The file is larger than the Converter Studio plan allows.',
  tooManyRequests: 'Too many requests to Converter Studio; try again in a minute.',
  serverBusy: 'Converter Studio is busy; try again in a few minutes.',
  unsupportedConversion: 'Converter Studio cannot convert this file to the chosen format.',
  conversionFailed: 'The conversion failed; no credits were charged.',
  fileExpired: 'The converted file expired before it was downloaded.',
  notFound: 'Converter Studio no longer has this conversion.',
  unknown: 'Something went wrong.',
};

/** An error with a code from the list above (or one the API sent) and a message to show. */
export class ConverterStudioError extends Error {
  /**
   * @param {string} code
   * @param {string} [message] shown to the user; the code's own words when left out
   * @param {{ status?: number, retryAfter?: number | null, params?: object | null }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message || ERROR_TEXT[code] || ERROR_TEXT.unknown);
    this.name = 'ConverterStudioError';
    this.code = code;
    this.status = extra.status ?? null;
    this.retryAfter = extra.retryAfter ?? null;
    this.params = extra.params ?? null;
  }
}

/** Any thrown value as a ConverterStudioError. */
export function asConverterStudioError(error) {
  if (error instanceof ConverterStudioError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ConverterStudioError('unknown', message || ERROR_TEXT.unknown);
}
