import * as path from 'path';
import * as os from 'os';
import { app, ipcMain, clipboard, shell, nativeImage, BrowserWindow } from 'electron';
import { createHash } from 'crypto';
import { menubar, Menubar } from 'menubar';
import * as store from './store';
import { events as serverEvents } from './server';
import * as mdns from './mdns';
import { getFavicon } from './favicon';

const ASSETS = path.join(app.getAppPath(), 'assets');
const ICON_IDLE = path.join(ASSETS, 'iconTemplate.png');
const ICON_UNREAD = path.join(ASSETS, 'icon-unreadTemplate.png');
const ICON_PULSE = path.join(ASSETS, 'iconPulseTemplate.png');
const PRELOAD = path.join(app.getAppPath(), 'dist', 'main', 'preload.js');
const SETTINGS_HTML = path.join(app.getAppPath(), 'dist', 'renderer', 'settings.html');

let mb: Menubar | null = null;
let settingsWin: BrowserWindow | null = null;
let pulseTimer: NodeJS.Timeout | null = null;
let pulsePhase = 0;

function setTrayIcon(file: string): void {
  if (!mb || !mb.tray) return;
  const img = nativeImage.createFromPath(file);
  img.setTemplateImage(true);
  mb.tray.setImage(img);
}

function steadyIcon(): string {
  return store.getLinks().length > 0 ? ICON_UNREAD : ICON_IDLE;
}

function startPulse(): void {
  if (pulseTimer) return;
  pulsePhase = 0;
  setTrayIcon(ICON_PULSE);
  pulseTimer = setInterval(() => {
    pulsePhase = (pulsePhase + 1) % 2;
    setTrayIcon(pulsePhase === 0 ? ICON_PULSE : ICON_IDLE);
  }, 700);
}

function stopPulse(): void {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
  setTrayIcon(steadyIcon());
}

function refreshIcon(): void {
  if (!mb || !mb.tray) return;
  if (!store.isPaired()) {
    startPulse();
    return;
  }
  stopPulse();
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

function notifyLinks(): void {
  broadcast('links-updated');
}

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'stash — Settings',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  void settingsWin.loadFile(SETTINGS_HTML);
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 6);
}

function localAddress(): string | null {
  for (const items of Object.values(os.networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return null;
}

function registerIpc(): void {
  ipcMain.handle('stash:getLinks', () => store.getLinks());
  ipcMain.handle('stash:removeLink', (_evt, id: string) => {
    store.removeLink(id);
    refreshIcon();
    notifyLinks();
  });
  ipcMain.handle('stash:clearAll', () => {
    store.clearAll();
    refreshIcon();
    notifyLinks();
  });
  ipcMain.handle('stash:copy', (_evt, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle('stash:open', (_evt, url: string) => {
    void shell.openExternal(url);
  });
  ipcMain.handle('stash:getFavicon', (_evt, hostname: string) => getFavicon(hostname));

  ipcMain.handle('stash:getPairing', () => ({
    secret: store.getSecret(),
    port: store.getPort(),
    paired: store.isPaired(),
    host: localAddress(),
    serviceName: `stash-${secretHash(store.getSecret())}`,
  }));
  ipcMain.handle('stash:getSettings', () => store.getSettings());
  ipcMain.handle('stash:updateSettings', (_evt, settings: Partial<store.Settings>) => {
    const next = store.updateSettings(settings);
    app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, openAsHidden: true });
    return next;
  });
  ipcMain.handle('stash:setPort', (_evt, port: number) => {
    store.setPort(port);
  });
  ipcMain.handle('stash:resetSecret', () => {
    const secret = store.resetSecret();
    return { secret, port: store.getPort() };
  });
  ipcMain.handle('stash:openSettings', () => {
    openSettings();
  });
}

export function init(): void {
  registerIpc();

  const idleImg = nativeImage.createFromPath(ICON_IDLE);
  idleImg.setTemplateImage(true);

  mb = menubar({
    index: `file://${path.join(app.getAppPath(), 'dist', 'renderer', 'stashover.html')}`,
    icon: idleImg,
    showDockIcon: false,
    preloadWindow: true,
    browserWindow: {
      width: 360,
      height: 480,
      resizable: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  });

  mb.on('ready', () => {
    refreshIcon();
  });

  mb.on('after-create-window', () => {
    notifyLinks();
  });

  serverEvents.on('link-added', () => {
    refreshIcon();
    notifyLinks();
  });

  serverEvents.on('link-updated', () => {
    notifyLinks();
  });

  store.events.on('links-changed', () => {
    refreshIcon();
    notifyLinks();
  });

  store.events.on('paired-changed', (paired: boolean) => {
    refreshIcon();
    broadcast('paired-changed', paired);
  });

  store.events.on('secret-reset', () => {
    void mdns.restart();
    refreshIcon();
  });
}

export function showSettings(): void {
  openSettings();
}
