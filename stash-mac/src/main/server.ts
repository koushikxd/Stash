import * as http from 'http';
import { EventEmitter } from 'events';
import { verifyBearer } from './auth';
import * as store from './store';
import { fetchMetadata } from './metadata';

const MAX_BODY_BYTES = 64 * 1024;

export const events = new EventEmitter();

class HttpError extends Error {
  constructor(readonly status: number, readonly body?: object) {
    super(`HTTP ${status}`);
  }
}

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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, { error: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body?: object): void {
  res.statusCode = status;
  if (body !== undefined) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  } else {
    res.end();
  }
}

function isValidUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0 || u.length > 4096) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || text.length > 4096) return null;
  return text;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method === 'GET' && url === '/ping') {
    if (!verifyBearer(req.headers.authorization, store.getSecret())) {
      send(res, 401);
      return;
    }
    store.markPaired();
    send(res, 200, { ok: true, version: 1 });
    return;
  }

  if (method === 'POST' && url === '/links') {
    if (!verifyBearer(req.headers.authorization, store.getSecret())) {
      send(res, 401);
      return;
    }
    store.markPaired();
    const raw = await readBody(req);
    let body: { url?: unknown; text?: unknown; title?: unknown; sentAt?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      send(res, 400, { error: 'invalid_json' });
      return;
    }
    const url = isValidUrl(body.url) ? body.url : null;
    const text = normalizedText(body.text) ?? url;
    if (!text) {
      send(res, 400, { error: 'invalid_payload' });
      return;
    }
    const result = store.addLink({
      url,
      text,
      title: typeof body.title === 'string' ? body.title : null,
      sentAt: typeof body.sentAt === 'number' ? body.sentAt : undefined,
    });
    events.emit(result.created ? 'link-added' : 'link-updated', result.link);
    if (result.link.url && needsMetadata(result.link)) enrichMetadata(result.link.id, result.link.url);
    send(res, result.created ? 201 : 200, { id: result.link.id });
    return;
  }

  if (method === 'POST' && url === '/links/batch') {
    if (!verifyBearer(req.headers.authorization, store.getSecret())) {
      send(res, 401);
      return;
    }
    store.markPaired();
    const raw = await readBody(req);
    let body: { links?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      send(res, 400, { error: 'invalid_json' });
      return;
    }
    if (!Array.isArray(body.links)) {
      send(res, 400, { error: 'invalid_payload' });
      return;
    }
    let accepted = 0;
    for (const item of body.links) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as { url?: unknown; text?: unknown; title?: unknown; sentAt?: unknown };
      const url = isValidUrl(obj.url) ? obj.url : null;
      const text = normalizedText(obj.text) ?? url;
      if (!text) continue;
      const result = store.addLink({
        url,
        text,
        title: typeof obj.title === 'string' ? obj.title : null,
        sentAt: typeof obj.sentAt === 'number' ? obj.sentAt : undefined,
      });
      events.emit(result.created ? 'link-added' : 'link-updated', result.link);
      if (result.link.url && needsMetadata(result.link)) enrichMetadata(result.link.id, result.link.url);
      accepted++;
    }
    send(res, 200, { accepted });
    return;
  }

  send(res, 404);
}

let server: http.Server | null = null;

export function start(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (err instanceof HttpError) send(res, err.status, err.body);
        else send(res, 500);
      });
    });
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      console.log(`[stash] http listening on 0.0.0.0:${port}`);
      resolve();
    });
  });
}

export function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = null;
  });
}
