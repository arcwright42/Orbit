import { contextBridge, ipcRenderer } from 'electron';
import type { OrbitApi, VoiceEvent } from '../contracts';

const api: OrbitApi = {
  voiceStart: wake => ipcRenderer.invoke('voice:start', wake),
  voiceStop: () => ipcRenderer.invoke('voice:stop'),
  voiceAudio: data => ipcRenderer.invoke('voice:audio', data),
  onVoice: listener => {
    const handler = (_event: unknown, data: VoiceEvent) => listener(data);
    ipcRenderer.on('voice:event', handler);
    return () => ipcRenderer.removeListener('voice:event', handler);
  },
  workspace: () => ipcRenderer.invoke('workspace:read'),
  submit: input => ipcRenderer.invoke('workspace:submit', input),
  cancelTask: id => ipcRenderer.invoke('task:cancel', id),
  pickAttachments: () => ipcRenderer.invoke('materials:pick'),
  openAttachment: id => ipcRenderer.invoke('materials:open', id),
  saveConnection: url => ipcRenderer.invoke('connection:save', url),
  checkConnection: () => ipcRenderer.invoke('connection:check'),
};
contextBridge.exposeInMainWorld('orbit', api);
