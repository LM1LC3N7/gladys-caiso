// -----------------------------------------------------------------------------
// The only network access: one GET of an open-data file, bounded in time
// (REQUEST_TIMEOUT, from the first byte sent to the last byte read) and in
// size (cut as soon as the cap is passed, before the body is complete), with
// an honest User-Agent, an explicit Accept, the conditional headers the
// source offers (ETag / Last-Modified), no redirect followed and no cookie
// kept (OASIS sets some: never sent back). A text answer is decoded as strict
// UTF-8; a binary one (the OASIS ZIP) is returned as bytes.
// -----------------------------------------------------------------------------

import { REQUEST_TIMEOUT, USER_AGENT } from './constants.js';

export class FetchError extends Error {
  /**
   * @param {string} code 'network' | 'timeout' | 'http' | 'rate_limited' | 'server' |
   *   'redirect' | 'too_large' | 'encoding' | 'aborted'
   */
  constructor(code, { status, retryAfter } = {}) {
    super(`fetch failed: ${code}${status ? ` ${status}` : ''}`);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Control characters (never in a header). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\0-\x1f\x7f]/;

/** A header value safe to send back (no CR, LF, control byte), else nothing. */
const safeHeader = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !CONTROL.test(value)
    ? value
    : undefined;

/** `Retry-After` in ms (seconds or an HTTP date against the server `Date`), else undefined. */
export function parseRetryAfter(value, serverDate) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  // Any number of seconds (the pause caps it): 12 digits at most, never a float.
  if (/^\d{1,12}$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isFinite(at) && Number.isFinite(serverDate)) return Math.max(0, at - serverDate);
  return undefined;
}

/** `Age` of a cache in ms (whole seconds, at most a day), else 0. */
export function parseAge(value) {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value.trim())) return 0;
  return Math.min(Number(value.trim()) * 1000, 24 * 60 * 60 * 1000);
}

/**
 * GET `url`. Resolves `{ status: 200, text | bytes, etag, lastModified, date }`
 * or `{ status: 304, date }`; throws a FetchError otherwise. `date` and
 * `lastModifiedAt` are epoch ms (NaN when absent or unreadable); `age` the
 * `Age` header of a cache in ms (0 when absent).
 * @param {{ url: string, accept: string, maxBytes: number, etag?: string,
 *   lastModified?: string, signal?: AbortSignal, fetchImpl?: typeof fetch,
 *   timeout?: number, timers?: object, binary?: boolean }} options
 */
export async function getBody({
  url,
  accept,
  maxBytes,
  etag,
  lastModified,
  signal,
  fetchImpl = fetch,
  timeout = REQUEST_TIMEOUT,
  timers = { setTimeout, clearTimeout },
  binary = false,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const fail = (err) => {
    if (err instanceof FetchError) return err;
    if (timedOut) return new FetchError('timeout');
    if (signal?.aborted) return new FetchError('aborted');
    return new FetchError('network');
  };
  try {
    const headers = { 'User-Agent': USER_AGENT, Accept: accept };
    if (safeHeader(etag)) headers['If-None-Match'] = etag;
    if (safeHeader(lastModified)) headers['If-Modified-Since'] = lastModified;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (err) {
      throw fail(err);
    }
    const date = Date.parse(response.headers.get('date') ?? '');
    const age = parseAge(response.headers.get('age') ?? undefined);
    const status = response.status;
    if (status === 304) {
      await response.body?.cancel().catch(() => {});
      return { status, date };
    }
    if (status !== 200) {
      await response.body?.cancel().catch(() => {});
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), date);
      if (status === 429) throw new FetchError('rate_limited', { status, retryAfter });
      if (status >= 500 && status <= 599) throw new FetchError('server', { status, retryAfter });
      if (status >= 300 && status <= 399) throw new FetchError('redirect', { status });
      throw new FetchError('http', { status });
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new FetchError('too_large');
    }
    const chunks = [];
    let size = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new FetchError('too_large');
        }
        chunks.push(value);
      }
    } catch (err) {
      throw fail(err);
    }
    const bytes = Buffer.concat(chunks);
    let text;
    if (!binary) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new FetchError('encoding');
      }
    }
    const modified = safeHeader(response.headers.get('last-modified') ?? undefined);
    return {
      status,
      ...(binary ? { bytes } : { text }),
      etag: safeHeader(response.headers.get('etag') ?? undefined),
      lastModified: modified,
      lastModifiedAt: modified === undefined ? NaN : Date.parse(modified),
      date,
      age,
    };
  } finally {
    timers.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
