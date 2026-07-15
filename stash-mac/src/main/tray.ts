import * as path from 'path';
import { app, ipcMain, clipboard, shell, nativeImage, BrowserWindow } from 'electron';
import { menubar, Menubar } from 'menubar';
import * as store from './store';
import { events as relayEvents, getStatus as getRelayStatus, NTFY_BASE_URL } from './ntfy';
import { getFavicon } from './favicon';

const ASSETS = path.join(app.getAppPath(), 'assets');
const ICON_IDLE = path.join(ASSETS, 'iconTemplate.png');
const ICON_UNREAD = path.join(ASSETS, 'icon-unreadTemplate.png');
const PRELOAD = path.join(app.getAppPath(), 'dist', 'main', 'preload.js');
const SETTINGS_HTML = path.join(app.getAppPath(), 'dist', 'renderer', 'settings.html');

let mb: Menubar | null = null;
let settingsWin: BrowserWindow | null = null;

function setTrayIcon(file: string): void {
  if (!mb || !mb.tray) return;
  const img = nativeImage.createFromPath(file);
  img.setTemplateImage(true);
  mb.tray.setImage(img);
}

function steadyIcon(): string {
  return store.getLinks().length > 0 ? ICON_UNREAD : ICON_IDLE;
}

function refreshIcon(): void {
  if (!mb || !mb.tray) return;
  setTrayIcon(steadyIcon());
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

function relayHost(): string {
  try {
    return new URL(NTFY_BASE_URL).host;
  } catch {
    return NTFY_BASE_URL;
  }
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

  ipcMain.handle('stash:getRelayStatus', () => {
    const status = getRelayStatus();
    return { connected: status.connected, lastEventAt: status.lastEventAt, relayHost: relayHost() };
  });
  ipcMain.handle('stash:getSettings', () => store.getSettings());
  ipcMain.handle('stash:updateSettings', (_evt, settings: Partial<store.Settings>) => {
    const next = store.updateSettings(settings);
    app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, openAsHidden: true });
    return next;
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

  relayEvents.on('link-added', () => {
    refreshIcon();
    notifyLinks();
  });

  relayEvents.on('link-updated', () => {
    notifyLinks();
  });

  store.events.on('links-changed', () => {
    refreshIcon();
    notifyLinks();
  });
}

export function showSettings(): void {
  openSettings();
}
