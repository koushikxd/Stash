import * as os from 'os';
import { createHash } from 'crypto';
import { Bonjour, Service } from 'bonjour-service';
import * as store from './store';

let bonjour: Bonjour | null = null;
let service: Service | null = null;

function shortHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 6);
}

export function start(port: number, secret: string): void {
  bonjour = new Bonjour();
  // Note: the secret is NOT broadcast. mDNS only advertises where the Mac is
  // (host/port via the service) and who it is (the .local hostname). The phone
  // already knows the shared secret it was built with.
  service = bonjour.publish({
    name: `stash-${shortHash(secret)}`,
    type: 'stash',
    protocol: 'tcp',
    port,
    txt: { version: '1', name: os.hostname() },
  });
  console.log(`[stash] mdns advertised _stash._tcp as stash-${shortHash(secret)} on :${port}`);
}

export function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!bonjour) return resolve();
    bonjour.unpublishAll(() => {
      bonjour?.destroy();
      bonjour = null;
      service = null;
      resolve();
    });
  });
}

export async function restart(): Promise<void> {
  await stop();
  start(store.getPort(), store.getSecret());
}
