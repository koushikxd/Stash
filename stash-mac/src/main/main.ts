import { app, powerMonitor } from 'electron';
import * as store from './store';
import * as relay from './relay';
import * as tray from './tray';
import { isSharedSecretConfigured, isRelayConfigured } from './sharedSecret';

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
  console.log('[stash] relay =', relay.getRelayHost());
  console.log('[stash] shared secret configured =', isSharedSecretConfigured());
  console.log('[stash] relay credentials configured =', isRelayConfigured());
  console.log('========================================');

  tray.init();
  relay.start();

  // Coming back to the machine is exactly when a backlog should drain. A network
  // change needs no handler of its own: the failed poll simply succeeds next time.
  powerMonitor.on('resume', () => relay.pollNow());
  powerMonitor.on('unlock-screen', () => relay.pollNow());
});

app.on('window-all-closed', () => {
  // keep app running in tray
});

app.on('before-quit', () => {
  relay.stop();
});
