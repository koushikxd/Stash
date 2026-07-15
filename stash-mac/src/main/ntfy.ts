import { app } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import * as store from './store';
import { fetchMetadata } from './metadata';
import { getSharedSecret } from './sharedSecret';

/**
 * Delivery over the public ntfy.sh pub/sub relay. The phone publishes each shared
 * link — encrypted with the shared secret — to an unguessable, secret-derived topic;
 * this module keeps a long-lived subscription to that topic, decrypts, stores, and
 * displays the link, then publishes an encrypted ack to a second topic so the phone
 * can mark the record delivered. Only a device holding the secret can read, write,
 * or decrypt the relay, so a public server is safe for one personal user.
 *
 * Base URL is a single constant so the whole relay can be repointed at a self-hosted
 * ntfy instance later with a one-line change.
 */

export const NTFY_BASE_URL = 'https://ntfy.sh';

export const events = new EventEmitter();

const IV_BYTES = 12;
const TAG_BYTES = 16;

const KEEPALIVE_TIMEOUT_MS = 150_000; // ntfy sends keepalives ~every 45s
const WATCHDOG_INTERVAL_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

const ACK_DEBOUNCE_MS = 1_000;
const ACK_MAX_IDS = 50;
const ACK_RETRY_MS = 30_000;

const SEEN_CAP = 2_000;

// --- crypto (mirrors util/Crypto.kt on Android) --------------------------------

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function key(): Buffer {
  return sha256(`key:${getSharedSecret()}`);
}

function topic(label: string): string {
  return 'st-' + sha256(`topic:${label}:${getSharedSecret()}`).toString('hex').slice(0, 32);
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
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

// --- metadata enrichment (moved verbatim from server.ts) -----------------------

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

// --- persisted read cursor + dedupe set ----------------------------------------

interface RelayState {
  since: string | null;
  seen: string[];
}

let state: RelayState = { since: null, seen: [] };
let statePath = '';

function loadState(): void {
  statePath = path.join(app.getPath('userData'), 'stash-relay.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<RelayState>;
    state = {
      since: typeof parsed.since === 'string' ? parsed.since : null,
      seen: Array.isArray(parsed.seen) ? parsed.seen.filter((s): s is string => typeof s === 'string') : [],
    };
  } catch {
    state = { since: null, seen: [] };
  }
}

function persist(): void {
  try {
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
  } catch {
    // best effort — a lost cursor is recovered by the dedupe set on replay
  }
}

function recordSeen(id: string): void {
  state.seen.push(id);
  if (state.seen.length > SEEN_CAP) state.seen.splice(0, state.seen.length - SEEN_CAP);
  persist();
}

// --- ack publishing ------------------------------------------------------------

let ackQueue: string[] = [];
let ackTimer: NodeJS.Timeout | null = null;

function queueAck(id: string): void {
  if (!ackQueue.includes(id)) ackQueue.push(id);
  if (ackQueue.length >= ACK_MAX_IDS) {
    void flushAcks();
    return;
  }
  if (!ackTimer) ackTimer = setTimeout(() => void flushAcks(), ACK_DEBOUNCE_MS);
}

async function flushAcks(): Promise<void> {
  if (ackTimer) {
    clearTimeout(ackTimer);
    ackTimer = null;
  }
  if (ackQueue.length === 0) return;
  const ids = ackQueue.splice(0, ACK_MAX_IDS);
  const envelope = encrypt(JSON.stringify({ v: 1, t: 'ack', ids }));
  try {
    const res = await fetch(`${NTFY_BASE_URL}/${topic('ack')}`, { method: 'POST', body: envelope });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    // Loss is non-fatal: the phone re-publishes unacked records and we re-ack on
    // the duplicate receive. Still, retry soon so the common case stays snappy.
    ackQueue.unshift(...ids);
    setTimeout(() => void flushAcks(), ACK_RETRY_MS);
  }
}

// --- message handling ----------------------------------------------------------

function processMessage(body: string): void {
  const plain = decrypt(body);
  if (plain === null) return; // wrong secret / corrupt — silently drop

  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const msg = parsed as { v?: unknown; t?: unknown; id?: unknown; text?: unknown; url?: unknown; createdAt?: unknown };
  if (msg.v !== 1 || msg.t !== 'link') return;
  if (typeof msg.id !== 'string' || typeof msg.text !== 'string') return;

  const recordId = msg.id;
  if (state.seen.includes(recordId)) {
    // Already stored — the phone re-published because our earlier ack was lost.
    queueAck(recordId);
    return;
  }

  const url = typeof msg.url === 'string' ? msg.url : null;
  const createdAt = typeof msg.createdAt === 'number' ? msg.createdAt : Date.now();
  const result = store.addLink({ url, text: msg.text, sentAt: createdAt });
  events.emit(result.created ? 'link-added' : 'link-updated', result.link);
  if (result.link.url && needsMetadata(result.link)) enrichMetadata(result.link.id, result.link.url);

  recordSeen(recordId);
  queueAck(recordId);
}

function handleLine(line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const obj = parsed as { event?: unknown; id?: unknown; message?: unknown };
  const event = typeof obj.event === 'string' ? obj.event : '';

  if (event === 'open' || event === 'keepalive') {
    lastEventAt = Date.now();
    return;
  }
  if (event !== 'message') return;

  if (typeof obj.message === 'string') processMessage(obj.message);
  if (typeof obj.id === 'string') {
    state.since = obj.id; // resume after this message on the next connect
    persist();
  }
}

// --- subscription lifecycle ----------------------------------------------------

let running = false;
let connected = false;
let lastEventAt = 0;
let reconnectDelay = RECONNECT_MIN_MS;
let controller: AbortController | null = null;
let watchdog: NodeJS.Timeout | null = null;
let wake: (() => void) | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
}

async function connectOnce(): Promise<void> {
  controller = new AbortController();
  const since = state.since ?? 'all';
  const url = `${NTFY_BASE_URL}/${topic('main')}/json?since=${encodeURIComponent(since)}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch {
    return; // offline / DNS — caller backs off
  }
  if (!res.ok || !res.body) return;

  connected = true;
  lastEventAt = Date.now();
  reconnectDelay = RECONNECT_MIN_MS;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      lastEventAt = Date.now();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(line);
      }
    }
  } catch {
    // aborted (reconnect/restart) or stream error — fall through to backoff
  } finally {
    connected = false;
  }
}

async function subscribeLoop(): Promise<void> {
  while (running) {
    await connectOnce();
    if (!running) break;
    await sleep(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}

function startWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (connected && Date.now() - lastEventAt > KEEPALIVE_TIMEOUT_MS) {
      console.log('[stash] relay watchdog: stream stalled — reconnecting');
      controller?.abort();
    }
  }, WATCHDOG_INTERVAL_MS);
}

export function start(): void {
  if (running) return;
  running = true;
  loadState();
  reconnectDelay = RECONNECT_MIN_MS;
  console.log(`[stash] relay: subscribing on ${NTFY_BASE_URL}`);
  startWatchdog();
  void subscribeLoop();
}

export function stop(): void {
  running = false;
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  controller?.abort();
  wake?.();
  connected = false;
}

/** Force an immediate reconnect (network change / wake from sleep). */
export function restart(): void {
  if (!running) {
    start();
    return;
  }
  reconnectDelay = RECONNECT_MIN_MS;
  controller?.abort();
  wake?.();
}

export function getStatus(): { connected: boolean; lastEventAt: number } {
  return { connected, lastEventAt };
}
