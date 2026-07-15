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
 */

const PLACEHOLDER = 'stash-mac-unconfigured-shared-secret';

function fromFile(): string | null {
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
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as { sharedSecret?: unknown };
      if (typeof parsed.sharedSecret === 'string' && parsed.sharedSecret.trim()) {
        return parsed.sharedSecret.trim();
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

let cached: string | null = null;

export function getSharedSecret(): string {
  if (cached) return cached;
  const fromEnv = process.env.STASH_SHARED_SECRET;
  cached = (fromEnv && fromEnv.trim()) || fromFile() || PLACEHOLDER;
  if (cached === PLACEHOLDER) {
    console.warn('[stash] using PLACEHOLDER shared secret — set STASH_SHARED_SECRET or stash.secret.json');
  }
  return cached;
}

export function isSharedSecretConfigured(): boolean {
  return getSharedSecret() !== PLACEHOLDER;
}
