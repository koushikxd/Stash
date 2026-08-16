import { app, powerMonitor } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, createDecipheriv } from 'crypto';
import * as store from './store';
import { fetchMetadata } from './metadata';
import {
  getSharedSecret,
  getRelayUrl,
  getRelayToken,
  isRelayConfigured,
  isSharedSecretConfigured,
} from './sharedSecret';

/**
 * Delivery over an Upstash Redis Stream. The phone publishes each shared link,
 * encrypted with the shared secret, to an unguessable secret-derived stream; this
 * module polls that stream, decrypts, stores, and displays the link.
 *
 * Stream entries wait for us: anything sent while this Mac is asleep or offline is
 * still there on the next poll. That durability is why there is no acknowledgement
 * channel. The phone's XADD proves the entry is stored, and our persisted cursor
 * guarantees we read it exactly once.
 *
 * Only a device holding the secret can decrypt the traffic, so a hosted relay is safe
 * for one personal user.
 */

export const events = new EventEmitter();

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Poll rate while you're at the machine, and while it sits idle or locked. */
const POLL_ACTIVE_MS = 30_000;
const POLL_IDLE_MS = 5 * 60_000;
/** Treat the Mac as idle after this much inactivity. */
const IDLE_AFTER_S = 300;

const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// --- crypto (mirrors util/Crypto.kt on Android) --------------------------------

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function key(): Buffer {
  return sha256(`key:${getSharedSecret()}`);
}

/** Must match the phone's secret-derived stream name byte for byte. */
function mainStream(): string {
  return 'st-' + sha256(`topic:main:${getSharedSecret()}`).toString('hex').slice(0, 32);
}

function decrypt(body: string): string | null {
  try {
    const raw = Buffer.from(body.trim(), 'base64');
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const ct = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// --- Redis REST transport -------------------------------------------------------

interface StreamEntry {
  id: string;
  body: string;
}

/**
 * Handle for the in-flight *read*, so `stop()` doesn't have to wait out the timeout.
 * Fire-and-forget writes deliberately don't register here: they'd clobber the read's
 * handle and `stop()` would abort the wrong request.
 */
let reading: AbortController | null = null;

/**
 * Execute one Redis command over the Upstash REST endpoint. Returns the `result`, or
 * null on any transport/protocol failure. Errors stay generic: no token, command body,
 * stream name, or payload is ever logged.
 */
async function command(args: string[], track = false): Promise<unknown> {
  if (!isRelayConfigured()) return null;
  const local = new AbortController();
  if (track) reading = local;
  const timer = setTimeout(() => local.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(getRelayUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getRelayToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: local.signal,
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as { result?: unknown; error?: unknown };
    if (parsed.error !== undefined) return null;
    return parsed.result ?? null;
  } catch {
    return null; // offline, aborted, or malformed response
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort retention. Failure here never invalidates a successful read or write. */
function trim(stream: string): void {
  void command(['XTRIM', stream, 'MINID', '~', `${Date.now() - RETENTION_MS}-0`]);
}

/**
 * Read up to PAGE_SIZE entries after `cursor` (exclusive), or from the oldest retained
 * entry when `cursor` is null. Returns entries in stream order, or null on a transport
 * error so callers can tell "empty" from "unreachable".
 */
async function readStream(stream: string, cursor: string | null): Promise<StreamEntry[] | null> {
  const start = cursor === null ? '-' : `(${cursor}`;
  const result = await command(['XRANGE', stream, start, '+', 'COUNT', String(PAGE_SIZE)], true);
  if (!Array.isArray(result)) return null;

  const entries: StreamEntry[] = [];
  for (const raw of result) {
    if (!Array.isArray(raw)) continue;
    const id: unknown = raw[0];
    const fields: unknown = raw[1];
    if (typeof id !== 'string' || !id) continue;
    // Fields arrive as a flat [name, value, ...] array; we only ever write "body".
    let body = '';
    if (Array.isArray(fields)) {
      for (let i = 0; i + 1 < fields.length; i += 2) {
        if (fields[i] === 'body' && typeof fields[i + 1] === 'string') {
          body = fields[i + 1] as string;
          break;
        }
      }
    }
    // A malformed entry still yields its id, so the cursor can move past it.
    entries.push({ id, body });
  }
  if (entries.length > 0) trim(stream);
  return entries;
}

// --- metadata enrichment --------------------------------------------------------

function enrichMetadata(id: string, url: string): void {
  void fetchMetadata(url).then((metadata) => {
    if (!metadata) return;
    store.updateLinkMetadata(id, metadata);
    events.emit('link-updated', id);
  });
}

function needsMetadata(link: store.Link): boolean {
  if (!link.url) return false;
  return !link.title || !link.description || !link.image || !link.siteName;
}

// --- persisted read cursor ------------------------------------------------------

let cursor: string | null = null;
let statePath = '';

function loadState(): void {
  statePath = path.join(app.getPath('userData'), 'stash-relay.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { cursor?: unknown };
    cursor = typeof parsed.cursor === 'string' ? parsed.cursor : null;
  } catch {
    cursor = null;
  }
}

function persist(): void {
  try {
    fs.writeFileSync(statePath, JSON.stringify({ cursor }), 'utf8');
  } catch {
    // Best effort. If the cursor is lost we replay the retained window, and
    // store.addLink dedupes by canonical url/text, so nothing lands twice.
  }
}

// --- message handling ----------------------------------------------------------

/** Returns false only if the entry could not be stored, which holds the cursor back. */
function processEntry(body: string): boolean {
  const plain = decrypt(body);
  if (plain === null) return true; // wrong secret / corrupt — drop and move past it

  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null) return true;
  // The phone's `id` is ignored: the cursor tracks delivery, and store.addLink dedupes.
  const msg = parsed as { v?: unknown; t?: unknown; text?: unknown; url?: unknown; createdAt?: unknown };
  if (msg.v !== 1 || msg.t !== 'link') return true;
  if (typeof msg.text !== 'string') return true;

  const url = typeof msg.url === 'string' ? msg.url : null;
  const createdAt = typeof msg.createdAt === 'number' ? msg.createdAt : Date.now();
  let result: ReturnType<typeof store.addLink>;
  try {
    result = store.addLink({ url, text: msg.text, sentAt: createdAt });
  } catch {
    return false; // local storage failed — re-read this entry on the next poll
  }
  events.emit(result.created ? 'link-added' : 'link-updated', result.link);
  if (result.link.url && needsMetadata(result.link)) enrichMetadata(result.link.id, result.link.url);
  return true;
}

// --- polling lifecycle ----------------------------------------------------------

let running = false;
let connected = false;
let lastEventAt = 0;
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;

/** Drain the main stream. Full pages are read back to back so backlogs clear at once. */
async function pollOnce(): Promise<void> {
  for (;;) {
    const entries = await readStream(mainStream(), cursor);
    if (entries === null) {
      // Keep lastEventAt: it records the last time the relay actually answered.
      connected = false;
      return;
    }
    // Any answered request means the relay is reachable, even an empty page.
    connected = true;
    lastEventAt = Date.now();
    if (entries.length === 0) return;

    for (const entry of entries) {
      if (!processEntry(entry.body)) return; // storage failure: don't advance past it
      cursor = entry.id;
      persist();
    }
    if (entries.length < PAGE_SIZE || !running) return;
  }
}

/**
 * Back off to a slow poll when nobody is at the Mac. Anything shared during that
 * window is still waiting on the stream, and wake/unlock forces an immediate poll.
 */
function nextInterval(): number {
  return powerMonitor.getSystemIdleTime() >= IDLE_AFTER_S ? POLL_IDLE_MS : POLL_ACTIVE_MS;
}

/**
 * Non-overlapping poll loop: each pass schedules the next only after it finishes, so a
 * slow request can never stack up behind a fixed interval.
 */
async function pollLoop(): Promise<void> {
  if (!running || polling) return;
  polling = true;
  try {
    await pollOnce();
  } finally {
    polling = false;
  }
  if (!running) return;
  pollTimer = setTimeout(() => void pollLoop(), nextInterval());
}

export function start(): void {
  if (running) return;
  // Without the right secret every entry fails to decrypt and the cursor would walk
  // past the whole retained backlog, destroying links that are still on the relay.
  // Refusing to read leaves them recoverable once the secret is in place.
  if (!isSharedSecretConfigured()) return;
  running = true;
  loadState();
  void pollLoop();
}

export function stop(): void {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  reading?.abort();
  connected = false;
}

/** Force an immediate poll (wake, unlock, popover opened). */
export function pollNow(): void {
  if (!running) {
    start();
    return;
  }
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  void pollLoop();
}

export function getStatus(): { connected: boolean; lastEventAt: number } {
  return { connected, lastEventAt };
}

/** Host of the configured relay endpoint, logged once at startup. */
export function getRelayHost(): string {
  const url = getRelayUrl();
  try {
    return url ? new URL(url).host : 'unconfigured';
  } catch {
    return 'unconfigured';
  }
}
