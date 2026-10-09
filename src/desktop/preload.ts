import { contextBridge, ipcRenderer } from 'electron';
import type { OrbitApi, VoiceEvent } from '../contracts';

const api: OrbitApi = {
  chatText: (text, ids) => ipcRenderer.invoke('chat:text', text, ids),
  localTeams: () => ipcRenderer.invoke('teams:list'),
  createTeam: name => ipcRenderer.invoke('teams:create', name),
  dispatchTask: (taskId, teamId) => ipcRenderer.invoke('execution:dispatch', taskId, teamId),
  execution: taskId => ipcRenderer.invoke('execution:detail', taskId),
  answerTask: (taskId, answer) => ipcRenderer.invoke('execution:answer', taskId, answer),
  reconcileTask: taskId => ipcRenderer.invoke('execution:reconcile', taskId),
  retryTask: taskId => ipcRenderer.invoke('execution:retry', taskId),
  acceptTask: taskId => ipcRenderer.invoke('execution:accept', taskId),
  reviseTask: (taskId, feedback) => ipcRenderer.invoke('execution:revise', taskId, feedback),
  openResult: (taskId, index) => ipcRenderer.invoke('execution:open', taskId, index),
  importContextPack: teamId => ipcRenderer.invoke('context:import', teamId),
  onWorkspace: listener => { const handler = () => listener(); ipcRenderer.on('workspace:changed', handler); return () => ipcRenderer.removeListener('workspace:changed', handler); },
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
