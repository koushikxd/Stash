import * as path from 'path';
import { app, ipcMain, clipboard, shell, nativeImage, BrowserWindow } from 'electron';
import { menubar, Menubar } from 'menubar';
import * as store from './store';
import { events as relayEvents, getStatus as getRelayStatus, getRelayHost, pollNow } from './relay';
import { getFavicon } from './favicon';
import { fetchMetadata } from './metadata';

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

function httpUrl(value: string): URL | null {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * Reading items are typed or pasted here, so unlike relayed links they are not already
 * validated by the phone. Anything with whitespace or no dotted host is treated as text.
 */
function toUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t || /\s/.test(t)) return null;
  const u = httpUrl(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  return u && u.hostname.includes('.') ? u.toString() : null;
}

function enrichReading(id: string, url: string): void {
  void fetchMetadata(url).then((metadata) => {
    if (!metadata) return;
    // Reading items are editable, so the url may have changed while this was in flight.
    // Applying by id alone would paint the old page's title and image onto the new one.
    if (store.getReading().find((item) => item.id === id)?.url !== url) return;
    // updateReadingMetadata emits 'reading-changed', which pushes the update itself.
    store.updateReadingMetadata(id, metadata);
  });
}

function openSettings(): void {
  // The status line reads "connected" from the last answered poll, which can be five
  // minutes stale while idle. Poll now so Settings doesn't show a false Offline.
  pollNow();
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

function registerIpc(): void {
  ipcMain.handle('stash:getLinks', () => store.getLinks());
  // Both of these refresh through store's 'links-changed' listener in init().
  ipcMain.handle('stash:removeLink', (_evt, id: string) => {
    store.removeLink(id);
  });
  ipcMain.handle('stash:clearAll', () => {
    store.clearAll();
  });
  ipcMain.handle('stash:getReading', () => store.getReading());
  ipcMain.handle('stash:addReadingFromClipboard', () => {
    const raw = clipboard.readText();
    const url = toUrl(raw);
    if (!url) return { added: false, text: raw.trim() };
    const { item } = store.addReading({ url, text: url });
    enrichReading(item.id, url);
    return { added: true };
  });
  ipcMain.handle('stash:addReading', (_evt, text: string) => {
    const url = toUrl(text);
    const { item } = store.addReading({ url, text: url ?? text });
    if (url) enrichReading(item.id, url);
  });
  ipcMain.handle('stash:updateReading', (_evt, id: string, text: string) => {
    const url = toUrl(text);
    const item = store.updateReading(id, { url, text: url ?? text });
    if (item && url) enrichReading(item.id, url);
  });
  ipcMain.handle('stash:removeReading', (_evt, id: string) => {
    store.removeReading(id);
  });
  ipcMain.handle('stash:clearReading', () => {
    store.clearReading();
  });

  ipcMain.handle('stash:copy', (_evt, text: string) => {
    clipboard.writeText(text);
  });
  // openExternal hands the URL to macOS, so anything but http(s) could launch another app.
  // Inbox links arrive from the phone and are never validated on this side.
  ipcMain.handle('stash:open', (_evt, url: string) => {
    if (httpUrl(url)) void shell.openExternal(url);
  });
  ipcMain.handle('stash:getFavicon', (_evt, hostname: string) => getFavicon(hostname));

  ipcMain.handle('stash:getRelayStatus', () => {
    const status = getRelayStatus();
    return { connected: status.connected, lastEventAt: status.lastEventAt, relayHost: getRelayHost() };
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

  // Opening the popover is a strong signal you want what's waiting on the relay.
  mb.on('after-show', () => {
    pollNow();
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

  // No refreshIcon() here: the tray badge stays inbox-only.
  store.events.on('reading-changed', () => {
    broadcast('reading-updated');
  });
}

export function showSettings(): void {
  openSettings();
}
