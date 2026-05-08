import { app, powerMonitor } from 'electron';
import * as store from './store';
import * as server from './server';
import * as mdns from './mdns';
import * as tray from './tray';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();

  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
  });

  store.init();
  const secret = store.getSecret();
  const port = store.getPort();

  console.log('========================================');
  console.log('[pop] secret =', secret);
  console.log('[pop] port   =', port);
  console.log('========================================');

  await server.start(port);
  mdns.start(port, secret);
  tray.init();

  if (!store.isPaired()) {
    tray.showSettings();
  }

  powerMonitor.on('resume', () => {
    console.log('[pop] resume — restarting mdns');
    void mdns.restart();
  });
});

app.on('window-all-closed', () => {
  // keep app running in tray
});

app.on('before-quit', async () => {
  await mdns.stop();
  await server.stop();
});
