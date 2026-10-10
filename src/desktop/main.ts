import { runtimeContext } from '../application/runtime-context';
import { platformTools } from '../application/platform-tools';
import { contextPolicy, estimateTokens, historyContext } from '../domains/conversation/context-budget';
import { foregroundPrompt, foregroundTools } from '../domains/conversation/tools';
import { TextModelStore } from '../domains/models/settings';
import { TextAgent } from '../domains/conversation/text-agent';
import type { TextModelInput, ChatEvent } from '../contracts';
import { importContextPack } from '../domains/context';
import { TaskExecutionService } from '../application/task-execution';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { RealtimeVoice } from '../domains/voice/realtime';
import { WakeDetector } from '../domains/voice/wake';
import type { VoiceEvent } from '../contracts';
import { safeStorage, systemPreferences, app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../infrastructure/database';
import { MaterialLibrary } from '../domains/materials/library';
import { WorkspaceService } from '../application/workspace';

try { loadEnvFile(resolve(__dirname, '../.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
app.setName('Orbit');
if (process.env.ORBIT_DATA_DIR) app.setPath('userData', resolve(process.env.ORBIT_DATA_DIR));
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
const dataDir = app.getPath('userData');
mkdirSync(dataDir, { recursive: true });
let window: BrowserWindow | null = null;
let quitting = false;
const devUrl = !app.isPackaged ? process.env.ORBIT_DEV_URL : undefined;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('Unexpected development URL');
const indexPath = join(__dirname, '../dist/index.html');
const trustedUrl = devUrl ?? pathToFileURL(indexPath).href;

app.whenReady().then(() => {
  if (!ownsInstance) return;
  const db = openDatabase(join(dataDir, 'orbit.sqlite'));
  const materials = new MaterialLibrary(db, join(dataDir, 'attachments'));
  const workspace = new WorkspaceService(db, materials);
  let reportUpdates = () => {};
  const execution = new TaskExecutionService(db, materials, dataDir, () => { if (window && !window.isDestroyed()) window.webContents.send('workspace:changed'); reportUpdates(); }, async (seat, item, directory, situation) => runtimeContext(seat,item,directory,execution.teams.seatRoot(seat),situation));
  const string = (value: unknown) => { if (typeof value !== 'string' || value.length > 16000) throw new Error('Invalid argument'); return value; };
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url.split('#')[0] !== trustedUrl && event.senderFrame.url.split('#')[0] !== `${trustedUrl}/`) {
        throw new Error('Untrusted IPC sender');
      }
      return action(...args);
    });
  };
  const emitVoice = (event: VoiceEvent) => { if (event.type === 'transcript') { workspace.recordInteraction(event.role, event.text, 'voice'); window?.webContents.send('workspace:changed'); } if (window && !window.isDestroyed()) window.webContents.send('voice:event', event); };
  const executePlatform = platformTools(workspace, execution, () => window?.webContents.send('workspace:changed'));
  const history = () => historyContext(workspace.snapshot().messages,
    contextPolicy.voiceHistoryTokens - estimateTokens({ instructions: foregroundPrompt, tools: foregroundTools }));
  const voice = new RealtimeVoice(emitVoice, executePlatform, undefined, history);
  const modelSettings = new TextModelStore(db, {
    encrypt: value => { if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('系统密钥存储不可用，无法保存 API Key。'); return safeStorage.encryptString(value).toString('base64'); },
    decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
  });
  const emitChat = (event: ChatEvent) => { if (window && !window.isDestroyed()) window.webContents.send('chat:event', event); };
  const textAgent = new TextAgent(db, modelSettings, executePlatform, emitChat, (role, text) => {
    workspace.recordInteraction(role, text, 'text'); voice.refreshHistory(); window?.webContents.send('workspace:changed');
  }, () => historyContext(workspace.snapshot().messages.filter(m => m.channel !== 'text'), contextPolicy.textWindowTokens / 4));
  handle('model:read', () => modelSettings.public());
  handle('model:save', value => { if (textAgent.busy) throw new Error('请先停止当前文本回复，再修改模型。'); return modelSettings.save(value as TextModelInput); });
  handle('chat:stop', () => textAgent.stop());
  const reported = new Map(workspace.snapshot().tasks.map(task => [task.id, task.status]));
  reportUpdates = () => {
    for (const task of workspace.snapshot().tasks) {
      const previous = reported.get(task.id); reported.set(task.id, task.status);
      if (previous === task.status || !['blocked', 'review', 'failed'].includes(task.status)) continue;
      const status = task.status === 'review' ? '成果已提交，等待你的验收' : task.status === 'blocked' ? '需要处理' : '执行失败';
      const message = `任务「${task.title}」${status}。${task.executionSummary ?? ''}`;
      workspace.recordInteraction('assistant', message); voice.notify(message);
    }
  };
  let wake: WakeDetector | undefined;
  let voiceGeneration = 0;
  const stopVoice = () => { voiceGeneration++; wake = undefined; voice.stop(); };
  handle('voice:start', async value => {
    if (typeof value !== 'boolean') throw new Error('Invalid voice mode');
    const generation = ++voiceGeneration;
    wake = undefined; if (value) voice.stop(false);
    if (process.platform === 'darwin' && !await systemPreferences.askForMediaAccess('microphone')) throw new Error('请在系统设置中允许 Orbit 使用麦克风。');
    if (generation !== voiceGeneration) return;
    if (value) { wake = new WakeDetector(resolve(__dirname, '../assets/voice')); emitVoice({ type: 'state', state: 'waiting' }); }
    else voice.start();
  });
  handle('chat:text', (text, ids) => {
    if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== 'string')) throw new Error('Invalid attachments');
    const files = ids.map(id => materials.require(id).attachment);
    return textAgent.send(string(text) + (files.length ? `\n已添加资料：${JSON.stringify(files.map(file => ({ id: file.id, name: file.name })))}` : ''));
  });
  handle('voice:stop', stopVoice);
  handle('voice:audio', value => {
    if (!(value instanceof Uint8Array) || value.length > 8192 || value.length % 2) throw new Error('Invalid audio frame');
    if (wake) { if (wake.accept(value)) { wake = undefined; window?.show(); voice.start(); } }
    else voice.audio(value);
  });
  app.on('before-quit', stopVoice);
  handle('context:import', async teamId => {
    const team = execution.teams.require(string(teamId));
    const choice = await dialog.showOpenDialog(window!, { title: '选择包含 manifest.yaml 的上下文包目录', properties: ['openDirectory'] });
    if (choice.canceled) return;
    const root = join(dataDir, 'context-packs'); mkdirSync(root, { recursive: true });
    const pack = importContextPack(choice.filePaths[0], join(root, randomUUID()));
    execution.setContextPack(team.id, pack.directory);
    window?.webContents.send('workspace:changed');
  });
  handle('templates:list', () => execution.templates.list());
  handle('templates:get', id => execution.templates.get(string(id)));
  handle('teams:list', () => execution.teams.list());
  handle('teams:create', (name, config, templateId) => execution.createTeam(string(name), config, templateId === undefined ? undefined : string(templateId)));
  handle('workspace:pick-directory', async () => { const choice = await dialog.showOpenDialog(window!, { title: '选择已有项目目录', properties: ['openDirectory'] }); return choice.canceled ? undefined : choice.filePaths[0]; });
  handle('execution:approve', (taskId, answer, itemId) => { execution.approve(string(taskId), string(answer), itemId === undefined ? undefined : string(itemId)); return workspace.snapshot(); });
  handle('execution:rotate', async (taskId, itemId) => { await execution.rotateSession(string(taskId), itemId === undefined ? undefined : string(itemId)); return workspace.snapshot(); });
  handle('execution:dispatch', async (taskId, teamId, directory) => { await execution.dispatch(string(taskId), string(teamId), directory === undefined ? undefined : string(directory)); return workspace.snapshot(); });
  handle('execution:detail', taskId => execution.detail(string(taskId)));
  handle('execution:answer', (taskId, answer) => { execution.answer(string(taskId), string(answer)); return workspace.snapshot(); });
  handle('execution:reconcile', taskId => { execution.reconcileStopped(string(taskId)); return workspace.snapshot(); });
  handle('execution:retry', taskId => { execution.retry(string(taskId)); return workspace.snapshot(); });
  handle('execution:accept', taskId => { execution.accept(string(taskId)); return workspace.snapshot(); });
  handle('execution:revise', async (taskId, feedback) => { await execution.revise(string(taskId), string(feedback)); return workspace.snapshot(); });
  handle('execution:open', async (taskId, index) => { if (typeof index !== 'number') throw new Error('Invalid artifact'); const error = await shell.openPath(execution.resultPath(string(taskId), index)); if (error) throw new Error(error); });
  handle('workspace:read', () => workspace.snapshot());
  handle('workspace:submit', input => workspace.submit(input));
  handle('task:cancel', async id => { await execution.cancel(string(id)); return workspace.snapshot(); });
  handle('connection:save', url => workspace.saveConnection(url));
  handle('connection:check', () => workspace.checkConnection());
  handle('materials:pick', async () => {
    const result = await dialog.showOpenDialog(window!, {
      properties: ['openFile'], title: '添加资料 · 单个文件最多 25 MB',
      filters: [{ name: '文档与图片', extensions: ['txt', 'md', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx', 'csv'] }],
    });
    if (result.canceled) return [];
    return [await materials.importFile(result.filePaths[0])];
  });
  handle('materials:open', async id => {
    if (typeof id !== 'string') throw new Error('附件标识无效。');
    const { path } = materials.require(id);
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });

  const createWindow = () => {
    window = new BrowserWindow({
      width: 1280, height: 860, minWidth: 900, minHeight: 650,
      title: 'Orbit', backgroundColor: '#fcfcfc', titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 20, y: 20 },
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    window.webContents.on('did-start-loading', stopVoice);
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => { callback(contents === window?.webContents && permission === 'media' && 'mediaTypes' in details && details.mediaTypes?.every((type: string) => type === 'audio') === true); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => {
      if (!quitting && process.platform === 'darwin') { event.preventDefault(); window?.hide(); }
    });
    window.on('closed', () => { window = null; });
    if (devUrl) void window.loadURL(devUrl); else void window.loadFile(indexPath);
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Orbit', submenu: [
      { role: 'about' },
      { label: '显示 Orbit', click: () => { if (!window) createWindow(); window!.show(); } },
      { type: 'separator' }, { role: 'hide' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  createWindow();
  app.on('activate', () => { if (!window) createWindow(); window!.show(); });
  let drained = false;
  app.on('before-quit', event => { if (drained) return; event.preventDefault(); void Promise.allSettled([textAgent.stop(), execution.close()]).finally(() => { drained = true; db.close(); app.quit(); }); });
  app.on('second-instance', () => { window?.show(); window?.focus(); });
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
