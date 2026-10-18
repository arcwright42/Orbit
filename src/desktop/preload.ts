import { contextBridge, ipcRenderer } from 'electron';
import type { Conversation, OrbitApi, VoiceEvent } from '../contracts';
import type { ModelConfigurationState } from '../domains/models/model';

const api: OrbitApi = {
  room: {
    read: page => ipcRenderer.invoke('room:read', page),
    onChanged: listener => {
      const handler = (_event: unknown, state: Conversation) => listener(state);
      ipcRenderer.on('room:state', handler);
      return () => ipcRenderer.removeListener('room:state', handler);
    },
  },
  models: {
    read: () => ipcRenderer.invoke('models:read'),
    catalog: providerId => ipcRenderer.invoke('models:catalog', providerId),
    save: input => ipcRenderer.invoke('models:save', input),
    remove: id => ipcRenderer.invoke('models:remove', id),
    activate: id => ipcRenderer.invoke('models:activate', id),
    detectCodex: () => ipcRenderer.invoke('models:detect-codex'),
    test: id => ipcRenderer.invoke('models:test', id),
    onChanged: listener => {
      const handler = (_event: unknown, state: ModelConfigurationState) => listener(state);
      ipcRenderer.on('models:state', handler);
      return () => ipcRenderer.removeListener('models:state', handler);
    },
  },
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
