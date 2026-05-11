import { app } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface Link {
  id: string;
  url: string;
  title: string | null;
  hostname: string;
  receivedAt: number;
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
      links: Array.isArray(parsed.links) ? parsed.links : [],
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

export function updateLinkTitle(id: string, title: string): void {
  const link = cache.links.find((l) => l.id === id);
  if (!link || link.title === title) return;
  link.title = title;
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

export function addLink(input: { url: string; title?: string | null; sentAt?: number }): Link {
  const link: Link = {
    id: randomUUID(),
    url: input.url,
    title: input.title ?? null,
    hostname: hostnameOf(input.url),
    receivedAt: input.sentAt ?? Date.now(),
  };
  cache.links.push(link);
  if (cache.links.length > cache.settings.maxHistory) {
    cache.links.splice(0, cache.links.length - cache.settings.maxHistory);
  }
  write();
  return link;
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
