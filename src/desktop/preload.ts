import { contextBridge, ipcRenderer } from 'electron';
import type { Conversation, OrbitApi, VoiceEvent } from '../contracts';

const api: OrbitApi = {
  conversation: () => ipcRenderer.invoke('conversation:read'),
  sendMessage: input => ipcRenderer.invoke('conversation:send', input),
  stopReply: () => ipcRenderer.invoke('conversation:abort'),
  onConversation: listener => {
    const handler = (_event: unknown, state: Conversation) => listener(state);
    ipcRenderer.on('conversation:state', handler);
    return () => ipcRenderer.removeListener('conversation:state', handler);
  },
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
};
contextBridge.exposeInMainWorld('orbit', api);
