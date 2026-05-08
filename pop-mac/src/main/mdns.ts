import * as os from 'os';
import { createHash } from 'crypto';
import { Bonjour, Service } from 'bonjour-service';

let bonjour: Bonjour | null = null;
let service: Service | null = null;
let currentPort = 0;
let currentSecret = '';

function shortHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 6);
}

export function start(port: number, secret: string): void {
  currentPort = port;
  currentSecret = secret;
  bonjour = new Bonjour();
  service = bonjour.publish({
    name: `pop-${shortHash(secret)}`,
    type: 'pop',
    protocol: 'tcp',
    port,
    txt: { version: '1', name: os.hostname() },
  });
  console.log(`[pop] mdns advertised _pop._tcp on :${port}`);
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
  if (!currentSecret) return;
  await stop();
  start(currentPort, currentSecret);
}
