import * as path from 'path';
import { app, ipcMain, clipboard, shell, nativeImage } from 'electron';
import { menubar, Menubar } from 'menubar';
import * as store from './store';
import { events as serverEvents } from './server';

const ASSETS = path.join(app.getAppPath(), 'assets');
const ICON_IDLE = path.join(ASSETS, 'iconTemplate.png');
const ICON_UNREAD = path.join(ASSETS, 'icon-unreadTemplate.png');

let mb: Menubar | null = null;

function pickIcon(): string {
  return store.getLinks().length > 0 ? ICON_UNREAD : ICON_IDLE;
}

function refreshIcon(): void {
  if (!mb || !mb.tray) return;
  const img = nativeImage.createFromPath(pickIcon());
  img.setTemplateImage(true);
  mb.tray.setImage(img);
}

function notifyRenderer(): void {
  const win = mb?.window;
  if (win && !win.isDestroyed()) {
    win.webContents.send('links-updated');
  }
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
        preload: path.join(app.getAppPath(), 'dist', 'main', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  });

  mb.on('ready', () => {
    refreshIcon();
  });

  mb.on('after-create-window', () => {
    notifyRenderer();
  });

  ipcMain.handle('pop:getLinks', () => store.getLinks());
  ipcMain.handle('pop:removeLink', (_evt, id: string) => {
    store.removeLink(id);
    refreshIcon();
    notifyRenderer();
  });
  ipcMain.handle('pop:clearAll', () => {
    store.clearAll();
    refreshIcon();
    notifyRenderer();
  });
  ipcMain.handle('pop:copy', (_evt, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle('pop:open', (_evt, url: string) => {
    void shell.openExternal(url);
  });

  serverEvents.on('link-added', () => {
    refreshIcon();
    notifyRenderer();
  });
}
