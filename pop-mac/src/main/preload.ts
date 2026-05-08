import { contextBridge, ipcRenderer } from 'electron';

export interface PopApi {
  getLinks: () => Promise<
    Array<{ id: string; url: string; title: string | null; hostname: string; receivedAt: number }>
  >;
  removeLink: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  copyToClipboard: (text: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  onLinksUpdated: (cb: () => void) => void;
}

const api: PopApi = {
  getLinks: () => ipcRenderer.invoke('pop:getLinks'),
  removeLink: (id) => ipcRenderer.invoke('pop:removeLink', id),
  clearAll: () => ipcRenderer.invoke('pop:clearAll'),
  copyToClipboard: (text) => ipcRenderer.invoke('pop:copy', text),
  openExternal: (url) => ipcRenderer.invoke('pop:open', url),
  onLinksUpdated: (cb) => {
    ipcRenderer.on('links-updated', () => cb());
  },
};

contextBridge.exposeInMainWorld('popApi', api);
