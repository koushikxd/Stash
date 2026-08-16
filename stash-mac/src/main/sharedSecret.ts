import * as fs from 'fs';
import * as path from 'path';

/**
 * The single shared secret that identifies "me". It is baked into both apps so the
 * Mac can authenticate links from my phone without any pairing step.
 *
 * Resolution order (first hit wins):
 *   1. STASH_SHARED_SECRET environment variable
 *   2. stash.secret.json next to the project / app root (gitignored)
 *   3. a platform-specific placeholder that lets the app run but never authenticates
 *
 * The SAME value must be set on Android (stash-android/secrets.properties).
 *
 * The same gitignored file also carries the Upstash Redis REST credentials used by the
 * relay transport. Those are transport-only and never feed the encryption secret.
 */

const PLACEHOLDER = 'stash-mac-unconfigured-shared-secret';

interface SecretFile {
  sharedSecret?: unknown;
  upstashRedisRestUrl?: unknown;
  upstashRedisRestToken?: unknown;
}

let fileCache: SecretFile | null = null;

function secretFile(): SecretFile {
  if (fileCache) return fileCache;
  // Look in the packaged Resources dir first (electron-builder `extraResources`
  // copies stash.secret.json there), then beside the project root in dev.
  const candidates = [
    path.join(process.resourcesPath, 'stash.secret.json'),
    path.join(process.cwd(), 'stash.secret.json'),
    path.join(__dirname, '..', '..', 'stash.secret.json'),
    path.join(__dirname, '..', '..', '..', 'stash.secret.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SecretFile;
      if (parsed && typeof parsed === 'object') {
        fileCache = parsed;
        return fileCache;
      }
    } catch {
      // try next candidate
    }
  }
  fileCache = {};
  return fileCache;
}

function fromFile(field: keyof SecretFile): string | null {
  const value = secretFile()[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

let cached: string | null = null;

export function getSharedSecret(): string {
  if (cached) return cached;
  const fromEnv = process.env.STASH_SHARED_SECRET;
  cached = (fromEnv && fromEnv.trim()) || fromFile('sharedSecret') || PLACEHOLDER;
  if (cached === PLACEHOLDER) {
    console.warn('[stash] using PLACEHOLDER shared secret — set STASH_SHARED_SECRET or stash.secret.json');
  }
  return cached;
}

export function isSharedSecretConfigured(): boolean {
  return getSharedSecret() !== PLACEHOLDER;
}

export function getRelayUrl(): string {
  const fromEnv = process.env.UPSTASH_REDIS_REST_URL;
  const url = (fromEnv && fromEnv.trim()) || fromFile('upstashRedisRestUrl') || '';
  return url.replace(/\/+$/, '');
}

export function getRelayToken(): string {
  const fromEnv = process.env.UPSTASH_REDIS_REST_TOKEN;
  return (fromEnv && fromEnv.trim()) || fromFile('upstashRedisRestToken') || '';
}

export function isRelayConfigured(): boolean {
  return getRelayUrl() !== '' && getRelayToken() !== '';
}
