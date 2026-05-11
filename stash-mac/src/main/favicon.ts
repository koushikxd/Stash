import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const MAX_BYTES = 256 * 1024;

function cacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'favicons');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cachePath(hostname: string): string {
  const key = createHash('sha256').update(hostname).digest('hex').slice(0, 32);
  return path.join(cacheDir(), `${key}.ico`);
}

async function download(url: string, file: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return false;
    fs.writeFileSync(file, buf);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getFavicon(hostname: string): Promise<string | null> {
  if (!hostname || !/^[a-z0-9.-]+$/i.test(hostname)) return null;
  const file = cachePath(hostname);
  if (fs.existsSync(file)) return `file://${file}`;
  const ok = await download(`https://${hostname}/favicon.ico`, file) || await download(`http://${hostname}/favicon.ico`, file);
  return ok ? `file://${file}` : null;
}
