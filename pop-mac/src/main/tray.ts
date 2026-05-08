import * as path from 'path';
import { app, ipcMain, clipboard, shell, nativeImage, BrowserWindow, Notification } from 'electron';
import { createHash } from 'crypto';
import { menubar, Menubar } from 'menubar';
import * as QRCode from 'qrcode';
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
    width: 380,
    height: 540,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'pop — Settings',
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

function showLinkNotification(): void {
  if (!store.getSettings().notifications || !Notification.isSupported()) return;
  const n = new Notification({ title: 'pop', body: 'New link from your phone' });
  n.on('click', () => {
    if (mb?.window) mb.showWindow();
  });
  n.show();
}

function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 6);
}

export function init(): void {
  const idleImg = nativeImage.createFromPath(ICON_IDLE);
  idleImg.setTemplateImage(true);

  mb = menubar({
    index: `file://${path.join(app.getAppPath(), 'dist', 'renderer', 'popover.html')}`,
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

  ipcMain.handle('pop:getLinks', () => store.getLinks());
  ipcMain.handle('pop:removeLink', (_evt, id: string) => {
    store.removeLink(id);
    refreshIcon();
    notifyLinks();
  });
  ipcMain.handle('pop:clearAll', () => {
    store.clearAll();
    refreshIcon();
    notifyLinks();
  });
  ipcMain.handle('pop:copy', (_evt, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle('pop:open', (_evt, url: string) => {
    void shell.openExternal(url);
  });
  ipcMain.handle('pop:getFavicon', (_evt, hostname: string) => getFavicon(hostname));

  ipcMain.handle('pop:getPairing', () => ({
    secret: store.getSecret(),
    port: store.getPort(),
    paired: store.isPaired(),
  }));
  ipcMain.handle('pop:getSettings', () => store.getSettings());
  ipcMain.handle('pop:updateSettings', (_evt, settings: Partial<store.Settings>) => {
    const next = store.updateSettings(settings);
    app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, openAsHidden: true });
    return next;
  });
  ipcMain.handle('pop:setPort', (_evt, port: number) => {
    store.setPort(port);
  });
  ipcMain.handle('pop:resetSecret', () => {
    const secret = store.resetSecret();
    return { secret, port: store.getPort() };
  });
  ipcMain.handle('pop:openSettings', () => {
    openSettings();
  });
  ipcMain.handle('pop:getPairingQr', async () => {
    const secret = store.getSecret();
    const payload = JSON.stringify({ v: 1, secret, port: store.getPort(), serviceName: `pop-${secretHash(secret)}` });
    return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 280 });
  });

  serverEvents.on('link-added', () => {
    refreshIcon();
    notifyLinks();
    showLinkNotification();
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
