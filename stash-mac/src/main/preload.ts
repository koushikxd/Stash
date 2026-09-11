import { contextBridge, ipcRenderer } from 'electron';

interface StashItem {
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
}

export interface StashApi {
  getLinks: () => Promise<StashItem[]>;
  removeLink: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;

  getReading: () => Promise<StashItem[]>;
  addReadingFromClipboard: () => Promise<{ added: boolean; text?: string }>;
  addReading: (text: string) => Promise<void>;
  updateReading: (id: string, text: string) => Promise<void>;
  removeReading: (id: string) => Promise<void>;
  clearReading: () => Promise<void>;
  onReadingUpdated: (cb: () => void) => void;

  copyToClipboard: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getFavicon: (hostname: string) => Promise<string | null>;
  onLinksUpdated: (cb: () => void) => void;

  getRelayStatus: () => Promise<{ connected: boolean; lastEventAt: number; relayHost: string }>;
  getSettings: () => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  updateSettings: (settings: Partial<{ launchAtLogin: boolean; maxHistory: number }>) => Promise<{ launchAtLogin: boolean; maxHistory: number }>;
  openSettings: () => Promise<void>;
}

const api: StashApi = {
  getLinks: () => ipcRenderer.invoke('stash:getLinks'),
  removeLink: (id) => ipcRenderer.invoke('stash:removeLink', id),
  clearAll: () => ipcRenderer.invoke('stash:clearAll'),

  getReading: () => ipcRenderer.invoke('stash:getReading'),
  addReadingFromClipboard: () => ipcRenderer.invoke('stash:addReadingFromClipboard'),
  addReading: (text) => ipcRenderer.invoke('stash:addReading', text),
  updateReading: (id, text) => ipcRenderer.invoke('stash:updateReading', id, text),
  removeReading: (id) => ipcRenderer.invoke('stash:removeReading', id),
  clearReading: () => ipcRenderer.invoke('stash:clearReading'),
  onReadingUpdated: (cb) => {
    ipcRenderer.on('reading-updated', () => cb());
  },

  copyToClipboard: (text) => ipcRenderer.invoke('stash:copy', text),
  openExternal: (url) => ipcRenderer.invoke('stash:open', url),
  getFavicon: (hostname) => ipcRenderer.invoke('stash:getFavicon', hostname),
  onLinksUpdated: (cb) => {
    ipcRenderer.on('links-updated', () => cb());
  },

  getRelayStatus: () => ipcRenderer.invoke('stash:getRelayStatus'),
  getSettings: () => ipcRenderer.invoke('stash:getSettings'),
  updateSettings: (settings) => ipcRenderer.invoke('stash:updateSettings', settings),
  openSettings: () => ipcRenderer.invoke('stash:openSettings'),
};

contextBridge.exposeInMainWorld('stashApi', api);
