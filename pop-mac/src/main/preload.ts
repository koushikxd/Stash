import { contextBridge, ipcRenderer } from 'electron';

export interface PopApi {
  getLinks: () => Promise<
    Array<{ id: string; url: string; title: string | null; hostname: string; receivedAt: number }>
  >;
  removeLink: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  copyToClipboard: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getFavicon: (hostname: string) => Promise<string | null>;
  onLinksUpdated: (cb: () => void) => void;

  getPairing: () => Promise<{ secret: string; port: number; paired: boolean }>;
  getSettings: () => Promise<{ notifications: boolean; launchAtLogin: boolean; maxHistory: number }>;
  updateSettings: (settings: Partial<{ notifications: boolean; launchAtLogin: boolean; maxHistory: number }>) => Promise<{ notifications: boolean; launchAtLogin: boolean; maxHistory: number }>;
  setPort: (port: number) => Promise<void>;
  resetSecret: () => Promise<{ secret: string; port: number }>;
  openSettings: () => Promise<void>;
  getPairingQr: () => Promise<string>;
  onPairedChanged: (cb: (paired: boolean) => void) => void;
}

const api: PopApi = {
  getLinks: () => ipcRenderer.invoke('pop:getLinks'),
  removeLink: (id) => ipcRenderer.invoke('pop:removeLink', id),
  clearAll: () => ipcRenderer.invoke('pop:clearAll'),
  copyToClipboard: (text) => ipcRenderer.invoke('pop:copy', text),
  openExternal: (url) => ipcRenderer.invoke('pop:open', url),
  getFavicon: (hostname) => ipcRenderer.invoke('pop:getFavicon', hostname),
  onLinksUpdated: (cb) => {
    ipcRenderer.on('links-updated', () => cb());
  },

  getPairing: () => ipcRenderer.invoke('pop:getPairing'),
  getSettings: () => ipcRenderer.invoke('pop:getSettings'),
  updateSettings: (settings) => ipcRenderer.invoke('pop:updateSettings', settings),
  setPort: (port) => ipcRenderer.invoke('pop:setPort', port),
  resetSecret: () => ipcRenderer.invoke('pop:resetSecret'),
  openSettings: () => ipcRenderer.invoke('pop:openSettings'),
  getPairingQr: () => ipcRenderer.invoke('pop:getPairingQr'),
  onPairedChanged: (cb) => {
    ipcRenderer.on('paired-changed', (_evt, paired: boolean) => cb(paired));
  },
};

contextBridge.exposeInMainWorld('popApi', api);
