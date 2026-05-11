import { contextBridge, ipcRenderer } from 'electron';

export interface StashApi {
  getLinks: () => Promise<
    Array<{ id: string; url: string; title: string | null; hostname: string; receivedAt: number }>
  >;
  removeLink: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  copyToClipboard: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getFavicon: (hostname: string) => Promise<string | null>;
  onLinksUpdated: (cb: () => void) => void;

  getPairing: () => Promise<{ secret: string; port: number; paired: boolean; host: string | null; serviceName: string }>;
  getSettings: () => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  updateSettings: (settings: Partial<{ launchAtLogin: boolean; maxHistory: number }>) => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  setPort: (port: number) => Promise<void>;
  resetSecret: () => Promise<{ secret: string; port: number }>;
  openSettings: () => Promise<void>;
  onPairedChanged: (cb: (paired: boolean) => void) => void;
}

const api: StashApi = {
  getLinks: () => ipcRenderer.invoke('stash:getLinks'),
  removeLink: (id) => ipcRenderer.invoke('stash:removeLink', id),
  clearAll: () => ipcRenderer.invoke('stash:clearAll'),
  copyToClipboard: (text) => ipcRenderer.invoke('stash:copy', text),
  openExternal: (url) => ipcRenderer.invoke('stash:open', url),
  getFavicon: (hostname) => ipcRenderer.invoke('stash:getFavicon', hostname),
  onLinksUpdated: (cb) => {
    ipcRenderer.on('links-updated', () => cb());
  },

  getPairing: () => ipcRenderer.invoke('stash:getPairing'),
  getSettings: () => ipcRenderer.invoke('stash:getSettings'),
  updateSettings: (settings) => ipcRenderer.invoke('stash:updateSettings', settings),
  setPort: (port) => ipcRenderer.invoke('stash:setPort', port),
  resetSecret: () => ipcRenderer.invoke('stash:resetSecret'),
  openSettings: () => ipcRenderer.invoke('stash:openSettings'),
  onPairedChanged: (cb) => {
    ipcRenderer.on('paired-changed', (_evt, paired: boolean) => cb(paired));
  },
};

contextBridge.exposeInMainWorld('stashApi', api);
