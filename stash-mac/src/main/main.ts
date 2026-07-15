import { app, powerMonitor } from 'electron';
import * as os from 'os';
import * as store from './store';
import * as ntfy from './ntfy';
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
let reconnectTimer: NodeJS.Timeout | null = null;

/**
 * The Mac's network can flip while it's awake (Wi-Fi switch, dock, VPN), which can
 * silently drop the relay stream. Poll the interface list and force a (debounced)
 * relay reconnect whenever it shifts, so delivery resumes without a restart.
 */
function watchNetworkChanges(): void {
  lastFingerprint = networkFingerprint();
  setInterval(() => {
    const current = networkFingerprint();
    if (current === lastFingerprint) return;
    lastFingerprint = current;
    console.log('[stash] network changed — reconnecting relay');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => ntfy.restart(), 1500);
  }, 5000);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  store.init();
  app.setLoginItemSettings({
    openAtLogin: store.getSettings().launchAtLogin,
    openAsHidden: true,
  });

  console.log('========================================');
  console.log('[stash] relay =', ntfy.NTFY_BASE_URL);
  console.log('[stash] shared secret configured =', isSharedSecretConfigured());
  console.log('========================================');

  tray.init();
  ntfy.start();

  powerMonitor.on('resume', () => {
    console.log('[stash] resume — reconnecting relay');
    ntfy.restart();
  });

  watchNetworkChanges();
});

app.on('window-all-closed', () => {
  // keep app running in tray
});

app.on('before-quit', () => {
  ntfy.stop();
});
