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
  secret: string;
  port: number;
  paired: boolean;
  links: Link[];
  settings: Settings;
}

const DEFAULT_SETTINGS: Settings = {
  launchAtLogin: true,
  maxHistory: 1000,
};

const DEFAULT_PORT = 7891;

let cache: StoreShape;
let storePath: string;

export const events = new EventEmitter();

function read(): StoreShape {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    return {
      secret: parsed.secret ?? randomUUID(),
      port: parsed.port ?? DEFAULT_PORT,
      paired: parsed.paired === true,
      links: Array.isArray(parsed.links) ? parsed.links.map(normalizeLink) : [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
    };
  } catch {
    return {
      secret: randomUUID(),
      port: DEFAULT_PORT,
      paired: false,
      links: [],
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

function write(): void {
  fs.writeFileSync(storePath, JSON.stringify(cache, null, 2), 'utf8');
}

export function init(): void {
  storePath = path.join(app.getPath('userData'), 'stash-store.json');
  cache = read();
  write();
}

export function getSecret(): string {
  return cache.secret;
}

export function getPort(): number {
  return cache.port;
}

export function isPaired(): boolean {
  return cache.paired;
}

export function markPaired(): void {
  if (cache.paired) return;
  cache.paired = true;
  write();
  events.emit('paired-changed', true);
}

export function resetSecret(): string {
  cache.secret = randomUUID();
  cache.paired = false;
  write();
  events.emit('secret-reset', cache.secret);
  events.emit('paired-changed', false);
  return cache.secret;
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

export function setPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || cache.port === port) return;
  cache.port = port;
  write();
  events.emit('port-changed', port);
}

export function getLinks(): Link[] {
  return cache.links.slice().sort((a, b) => b.receivedAt - a.receivedAt);
}

export function updateLinkMetadata(id: string, metadata: LinkMetadata): void {
  const link = cache.links.find((l) => l.id === id);
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
  events.emit('links-changed');
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

export function addLink(input: { url?: string | null; text?: string | null; title?: string | null; sentAt?: number }): { link: Link; created: boolean } {
  const receivedAt = input.sentAt ?? Date.now();
  const url = input.url ?? null;
  const text = canonicalText(input.text || url || '');
  const existing = url
    ? cache.links.find((link) => link.url && canonicalUrl(link.url) === canonicalUrl(url))
    : cache.links.find((link) => !link.url && canonicalText(link.text) === text);
  if (existing) {
    existing.kind = url ? 'link' : 'text';
    existing.text = text;
    existing.url = url;
    existing.hostname = url ? hostnameOf(url) : '';
    existing.receivedAt = Math.min(existing.receivedAt, receivedAt);
    if (input.title && existing.title !== input.title) existing.title = input.title;
    write();
    return { link: existing, created: false };
  }
  const link: Link = {
    id: randomUUID(),
    kind: url ? 'link' : 'text',
    text,
    url,
    title: input.title ?? null,
    description: null,
    image: null,
    siteName: null,
    hostname: url ? hostnameOf(url) : '',
    receivedAt,
  };
  cache.links.push(link);
  if (cache.links.length > cache.settings.maxHistory) {
    cache.links.splice(0, cache.links.length - cache.settings.maxHistory);
  }
  write();
  return { link, created: true };
}

export function removeLink(id: string): void {
  const before = cache.links.length;
  cache.links = cache.links.filter((l) => l.id !== id);
  if (cache.links.length !== before) write();
}

export function clearAll(): void {
  if (cache.links.length === 0) return;
  cache.links = [];
  write();
}
