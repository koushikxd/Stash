import { app } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface Link {
  id: string;
  kind: 'link' | 'text';
  text: string;
  url: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  hostname: string;
  receivedAt: number;
}

export interface LinkMetadata {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  siteName?: string | null;
}

export interface Settings {
  launchAtLogin: boolean;
  maxHistory: number;
}

interface StoreShape {
  links: Link[];
  /** Mac-local reading list. Never touched by the relay. */
  reading: Link[];
  settings: Settings;
}

type ListKey = 'links' | 'reading';

const CHANGED: Record<ListKey, string> = { links: 'links-changed', reading: 'reading-changed' };

const DEFAULT_SETTINGS: Settings = {
  launchAtLogin: true,
  maxHistory: 1000,
};

let cache: StoreShape;
let storePath: string;

export const events = new EventEmitter();

function read(): StoreShape {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    return {
      links: Array.isArray(parsed.links) ? parsed.links.map(normalizeLink) : [],
      reading: Array.isArray(parsed.reading) ? parsed.reading.map(normalizeLink) : [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
    };
  } catch {
    return {
      links: [],
      reading: [],
      settings: { ...DEFAULT_SETTINGS },
    };
  }
}

function normalizeLink(link: Partial<Link>): Link {
  const url = typeof link.url === 'string' ? link.url : '';
  const text = typeof link.text === 'string' && link.text.trim() ? link.text : url;
  const kind = url ? 'link' : 'text';
  return {
    id: typeof link.id === 'string' ? link.id : randomUUID(),
    kind,
    text,
    url: url || null,
    title: typeof link.title === 'string' ? link.title : null,
    description: typeof link.description === 'string' ? link.description : null,
    image: typeof link.image === 'string' ? link.image : null,
    siteName: typeof link.siteName === 'string' ? link.siteName : null,
    hostname: typeof link.hostname === 'string' ? link.hostname : hostnameOf(url),
    receivedAt: typeof link.receivedAt === 'number' ? link.receivedAt : Date.now(),
  };
}

/**
 * Atomic write. A crash or full disk mid-write would otherwise leave a truncated file,
 * which `read()` cannot parse and would silently treat as "no links".
 */
function write(): void {
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, storePath);
}

export function init(): void {
  storePath = path.join(app.getPath('userData'), 'stash-store.json');
  cache = read();
  // Never write on startup: an unparseable file is kept as-is for recovery rather
  // than being overwritten with the empty default.
}

export function getSettings(): Settings {
  return { ...cache.settings };
}

export function updateSettings(settings: Partial<Settings>): Settings {
  cache.settings = { ...cache.settings, ...settings };
  write();
  events.emit('settings-changed', getSettings());
  return getSettings();
}

export function getLinks(): Link[] {
  return cache.links.slice().sort((a, b) => b.receivedAt - a.receivedAt);
}

function updateMetadata(key: ListKey, id: string, metadata: LinkMetadata): void {
  const link = cache[key].find((l) => l.id === id);
  if (!link) return;
  let changed = false;
  if (metadata.title && link.title !== metadata.title) {
    link.title = metadata.title;
    changed = true;
  }
  if (metadata.description && link.description !== metadata.description) {
    link.description = metadata.description;
    changed = true;
  }
  if (metadata.image && link.image !== metadata.image) {
    link.image = metadata.image;
    changed = true;
  }
  if (metadata.siteName && link.siteName !== metadata.siteName) {
    link.siteName = metadata.siteName;
    changed = true;
  }
  if (!changed) return;
  write();
  events.emit(CHANGED[key]);
}

function removeFrom(key: ListKey, id: string): void {
  const before = cache[key].length;
  cache[key] = cache[key].filter((l) => l.id !== id);
  if (cache[key].length === before) return;
  write();
  events.emit(CHANGED[key]);
}

function clearList(key: ListKey): void {
  if (cache[key].length === 0) return;
  cache[key] = [];
  write();
  events.emit(CHANGED[key]);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';
    if (parsed.pathname === '/') parsed.pathname = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function canonicalText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function findDuplicate(list: Link[], url: string | null, text: string): Link | undefined {
  return url
    ? list.find((link) => link.url && canonicalUrl(link.url) === canonicalUrl(url))
    : list.find((link) => !link.url && canonicalText(link.text) === text);
}

function makeLink(url: string | null, text: string, title: string | null, receivedAt: number): Link {
  return {
    id: randomUUID(),
    kind: url ? 'link' : 'text',
    text,
    url,
    title,
    description: null,
    image: null,
    siteName: null,
    hostname: url ? hostnameOf(url) : '',
    receivedAt,
  };
}

export function addLink(input: { url?: string | null; text?: string | null; title?: string | null; sentAt?: number }): { link: Link; created: boolean } {
  const receivedAt = input.sentAt ?? Date.now();
  const url = input.url ?? null;
  const text = canonicalText(input.text || url || '');
  const existing = findDuplicate(cache.links, url, text);
  if (existing) {
    existing.kind = url ? 'link' : 'text';
    existing.text = text;
    existing.url = url;
    existing.hostname = url ? hostnameOf(url) : '';
    // A re-share must not jump the inbox order.
    existing.receivedAt = Math.min(existing.receivedAt, receivedAt);
    if (input.title && existing.title !== input.title) existing.title = input.title;
    write();
    return { link: existing, created: false };
  }
  const link = makeLink(url, text, input.title ?? null, receivedAt);
  cache.links.push(link);
  if (cache.links.length > cache.settings.maxHistory) {
    cache.links.splice(0, cache.links.length - cache.settings.maxHistory);
  }
  write();
  return { link, created: true };
}

export function removeLink(id: string): void {
  removeFrom('links', id);
}

export function clearAll(): void {
  clearList('links');
}

export function updateLinkMetadata(id: string, metadata: LinkMetadata): void {
  updateMetadata('links', id, metadata);
}

// --- reading list ---------------------------------------------------------------

export function getReading(): Link[] {
  return cache.reading.slice().sort((a, b) => b.receivedAt - a.receivedAt);
}

/**
 * Unlike addLink, this emits on its own: the reading list has no relay to emit for it.
 * Re-adding an item bumps it to the top, and the list is never trimmed — every entry
 * here is a deliberate save.
 */
export function addReading(input: { url?: string | null; text?: string | null }): { item: Link; created: boolean } {
  const url = input.url ?? null;
  const text = canonicalText(input.text || url || '');
  const existing = findDuplicate(cache.reading, url, text);
  if (existing) {
    existing.receivedAt = Date.now();
    write();
    events.emit('reading-changed');
    return { item: existing, created: false };
  }
  const item = makeLink(url, text, null, Date.now());
  cache.reading.push(item);
  write();
  events.emit('reading-changed');
  return { item, created: true };
}

/** Replaces the target, so stale metadata from the previous url is cleared. */
export function updateReading(id: string, input: { url?: string | null; text?: string | null }): Link | null {
  const item = cache.reading.find((l) => l.id === id);
  if (!item) return null;
  const url = input.url ?? null;
  item.kind = url ? 'link' : 'text';
  item.text = canonicalText(input.text || url || '');
  item.url = url;
  item.hostname = url ? hostnameOf(url) : '';
  item.title = null;
  item.description = null;
  item.image = null;
  item.siteName = null;
  write();
  events.emit('reading-changed');
  return item;
}

export function removeReading(id: string): void {
  removeFrom('reading', id);
}

export function clearReading(): void {
  clearList('reading');
}

export function updateReadingMetadata(id: string, metadata: LinkMetadata): void {
  updateMetadata('reading', id, metadata);
}
