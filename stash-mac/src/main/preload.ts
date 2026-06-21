import { contextBridge, ipcRenderer } from 'electron';

export interface StashApi {
  getLinks: () => Promise<
    Array<{
      id: string;
      kind: 'link' | 'text';
      text: string;
      url: string | null;
      title: string | null;
      description: string | null;
      image: string | null;
      siteName: string | null;
      hostname: string;
      receivedAt: number;
    }>
  >;
  removeLink: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  copyToClipboard: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getFavicon: (hostname: string) => Promise<string | null>;
  onLinksUpdated: (cb: () => void) => void;

  getNetworkInfo: () => Promise<{ port: number; host: string | null }>;
  getSettings: () => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  updateSettings: (settings: Partial<{ launchAtLogin: boolean; maxHistory: number }>) => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  setPort: (port: number) => Promise<void>;
  openSettings: () => Promise<void>;
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

  getNetworkInfo: () => ipcRenderer.invoke('stash:getNetworkInfo'),
  getSettings: () => ipcRenderer.invoke('stash:getSettings'),
  updateSettings: (settings) => ipcRenderer.invoke('stash:updateSettings', settings),
  setPort: (port) => ipcRenderer.invoke('stash:setPort', port),
  openSettings: () => ipcRenderer.invoke('stash:openSettings'),
};

contextBridge.exposeInMainWorld('stashApi', api);
