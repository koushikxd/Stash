import { app, powerMonitor } from 'electron';
import * as os from 'os';
import * as store from './store';
import * as server from './server';
import * as mdns from './mdns';
import * as tray from './tray';
import { isSharedSecretConfigured } from './sharedSecret';

/** A stable fingerprint of the Mac's current non-internal IPv4 addresses. */
function networkFingerprint(): string {
  const addrs: string[] = [];
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.family === 'IPv4' && !item.internal) addrs.push(item.address);
    }
  }
  return addrs.sort().join(',');
}

let lastFingerprint = '';
let readvertiseTimer: NodeJS.Timeout | null = null;

/**
 * The Mac's LAN IP can change while it's awake (WiFi switch, dock, VPN). mDNS only
 * re-advertised on sleep/resume before, so discovery could hand the phone a dead
 * address. Poll the interface list and re-advertise (debounced) whenever it shifts.
 */
function watchNetworkChanges(): void {
  lastFingerprint = networkFingerprint();
  setInterval(() => {
    const current = networkFingerprint();
    if (current === lastFingerprint) return;
    lastFingerprint = current;
    console.log('[stash] network changed — re-advertising mdns');
    if (readvertiseTimer) clearTimeout(readvertiseTimer);
    readvertiseTimer = setTimeout(() => {
      void mdns.restart();
    }, 1500);
  }, 5000);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();

  store.init();
  app.setLoginItemSettings({
    openAtLogin: store.getSettings().launchAtLogin,
    openAsHidden: true,
  });
  const secret = store.getSecret();
  const port = store.getPort();

  console.log('========================================');
  console.log('[stash] port   =', port);
  console.log('[stash] shared secret configured =', isSharedSecretConfigured());
  console.log('========================================');

  await server.start(port);
  mdns.start(port, secret);
  tray.init();

  powerMonitor.on('resume', () => {
    console.log('[stash] resume — restarting mdns');
    void mdns.restart();
  });

  watchNetworkChanges();
});

app.on('window-all-closed', () => {
  // keep app running in tray
});

app.on('before-quit', async () => {
  await mdns.stop();
  await server.stop();
});
