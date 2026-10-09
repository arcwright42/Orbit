import { contextBridge, ipcRenderer } from 'electron';
import type { OrbitApi } from '../contracts';

const api: OrbitApi = {
  workspace: () => ipcRenderer.invoke('workspace:read'),
  submit: input => ipcRenderer.invoke('workspace:submit', input),
  cancelTask: id => ipcRenderer.invoke('task:cancel', id),
  pickAttachments: () => ipcRenderer.invoke('materials:pick'),
  openAttachment: id => ipcRenderer.invoke('materials:open', id),
  saveConnection: url => ipcRenderer.invoke('connection:save', url),
  checkConnection: () => ipcRenderer.invoke('connection:check'),
};
contextBridge.exposeInMainWorld('orbit', api);
