import { loadEnvFile } from 'node:process';
import { RealtimeVoice } from '../domains/voice/realtime';
import { WakeDetector } from '../domains/voice/wake';
import type { Conversation, VoiceEvent } from '../contracts';
import { systemPreferences, app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, utilityProcess } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../infrastructure/database';
import { MaterialLibrary } from '../domains/materials/library';
import { WorkspaceService } from '../application/workspace';
import { InteractionService, INTERACTION_PROMPT, INTERACTION_TOOLS, HISTORY_PROMPT } from '../application/interaction';
import { RoomService } from '../application/room';
import { FileRoomHistory } from '../infrastructure/history/store';
import { PiAgentHost } from '../infrastructure/pi/host';
import { ModelConfigurationService } from '../application/models';
import { ModelConfigurationError } from '../domains/models/model';
import { LocalCodexCredentials } from '../infrastructure/models/codex';
import { environmentProfile } from '../infrastructure/models/environment';
import { FileModelRepository, protectedSecrets } from '../infrastructure/models/store';
import { TaskExecutionService } from '../application/task-execution';
import { ExecutionRepository } from '../domains/tasks/execution-repository';
import { TaskFiles } from '../infrastructure/tasks/files';
import { ExecutionRuntimeHost } from '../infrastructure/execution/host';
import { boundedText, type TaskEvent } from '../domains/tasks/execution';

try { loadEnvFile(resolve(__dirname, '../.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
app.setName('Orbit');
if (process.env.ORBIT_DATA_DIR) app.setPath('userData', resolve(process.env.ORBIT_DATA_DIR));
const dataDir = app.getPath('userData');
mkdirSync(dataDir, { recursive: true });
let window: BrowserWindow | null = null;
let quitting = false;
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => { window?.show(); window?.focus(); });
const devUrl = !app.isPackaged ? process.env.ORBIT_DEV_URL : undefined;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('Unexpected development URL');
const indexPath = join(__dirname, '../dist/index.html');
const trustedUrl = devUrl ?? pathToFileURL(indexPath).href;

if (ownsInstance) app.whenReady().then(() => {
  const db = openDatabase(join(dataDir, 'orbit.sqlite'));
  const materials = new MaterialLibrary(db, join(dataDir, 'attachments'));
  const workspace = new WorkspaceService(db, materials);
  const history = new FileRoomHistory(dataDir);
  history.migrate(join(dataDir, 'agent'), workspace.snapshot().messages);
  let interaction: InteractionService;
  let room: RoomService;
  const emitConversation = (state: Conversation) => {
    room?.acceptPi(state);
    if (window && !window.isDestroyed()) window.webContents.send('conversation:state', state);
  };
  let models: ModelConfigurationService;
  const agent = new PiAgentHost(() => {
    const child = utilityProcess.fork(join(__dirname, 'agent-worker.mjs'), [], { serviceName: 'Orbit interaction agent', stdio: 'ignore' });
    return {
      send: message => child.postMessage(message),
      onMessage: listener => { child.on('message', listener); },
      onExit: listener => { child.on('exit', listener); },
      kill: () => { child.kill(); },
    };
  }, { directory: history.runtimeDirectory, roomId: history.roomId, systemPrompt: INTERACTION_PROMPT + HISTORY_PROMPT, tools: INTERACTION_TOOLS },
  (name, args, context) => room.execute(name, args, context), emitConversation,
  { current: () => models.current(), credential: id => models.credential(id) });
  models = new ModelConfigurationService(
    new FileModelRepository(join(dataDir, 'models.json')), protectedSecrets(safeStorage),
    new LocalCodexCredentials(), agent,
    { profile: environmentProfile(process.env), apiKey: process.env.ORBIT_AGENT_API_KEY },
    state => { if (window && !window.isDestroyed()) window.webContents.send('models:state', state); },
  );
  const executionRepository = new ExecutionRepository(db);
  const taskRuntime = new ExecutionRuntimeHost({ worker: join(__dirname, 'task-worker.mjs'), mcpBridge: join(__dirname, 'task-mcp.mjs'),
    model: () => models.current(), credential: profile => models.executionCredential(profile) });
  const executionReceipt = (event: TaskEvent) => {
    const significant = ['task.dispatched', 'task.question', 'task.canceled', 'task.accepted', 'run.failed', 'recovery.blocked'].includes(event.type)
      || event.type === 'run.completed' && event.taskStatus === 'review';
    if (!significant) return;
    const message = { id: 'task-event-' + event.seq, role: 'system', taskId: event.taskId,
      text: event.type === 'run.completed' ? '任务成果已就绪，请在任务详情查看并验收。' : event.message, createdAt: event.createdAt };
    db.prepare('INSERT OR IGNORE INTO messages VALUES (?, ?, ?)').run(message.id, event.taskId, JSON.stringify(message));
    room?.syncWorkspace();
  };
  const execution = new TaskExecutionService(executionRepository, new TaskFiles(join(dataDir, 'tasks'), materials), taskRuntime, () => {
    const settings = executionRepository.settings();
    return { runtime: settings.runtime, ...(settings.runtime === 'pi' && models.current() ? { model: models.current()! } : {}) };
  }, event => {
    executionReceipt(event);
    if (window && !window.isDestroyed()) window.webContents.send('execution:event', event);
  });
  // Recover committed notifications even if the app stopped before the Room projection was written.
  for (const row of db.prepare("SELECT e.seq, e.payload FROM task_events e LEFT JOIN messages m ON m.id = 'task-event-' || e.seq WHERE m.id IS NULL ORDER BY e.seq").all()) {
    executionReceipt({ ...JSON.parse(String(row.payload)), seq: Number(row.seq) });
  }
  interaction = new InteractionService(workspace, history, execution);
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url.split('#')[0] !== trustedUrl && event.senderFrame.url.split('#')[0] !== `${trustedUrl}/`) {
        throw new Error('Untrusted IPC sender');
      }
      return action(...args);
    });
  };
  const modelHandle = (channel: string, action: (...args: unknown[]) => unknown) => handle(channel, async (...args) => {
    try { return await action(...args); }
    catch (error) { throw new Error(error instanceof ModelConfigurationError ? error.message : '模型配置操作失败，请重试。'); }
  });
  modelHandle('models:read', () => models.read());
  modelHandle('models:catalog', id => models.catalog(id));
  modelHandle('models:save', input => models.save(input));
  modelHandle('models:remove', id => models.remove(id));
  modelHandle('models:activate', id => models.activate(id));
  modelHandle('models:detect-codex', () => models.detectCodex());
  modelHandle('models:test', id => models.test(id));
  const taskId = (value: unknown) => boundedText(value, '任务标识', 100);
  let executionStartupError: string | undefined;
  const executionConfiguration = async () => ({ settings: execution.settings(), runtimes: await taskRuntime.availability(), error: executionStartupError });
  handle('execution:configuration', executionConfiguration);
  handle('execution:configure', async settings => { execution.configure(settings); return executionConfiguration(); });
  handle('execution:detail', (id, before) => execution.detail(taskId(id), before as number | undefined));
  handle('execution:dispatch', (id, mode) => execution.dispatch(taskId(id), mode as 'direct' | 'plan', history.roomId));
  handle('execution:retry', id => execution.retry(taskId(id)));
  handle('execution:answer', (id, questionId, answer) => execution.answer(taskId(id), boundedText(questionId, '问题标识', 100), answer));
  handle('execution:accept', id => execution.accept(taskId(id)));
  handle('execution:open-artifact', async (id, path) => { const error = await shell.openPath(execution.artifact(taskId(id), boundedText(path, '成果路径', 4096))); if (error) throw new Error('无法打开成果文件。'); });
  handle('execution:open-directory', async id => {
    const task = executionRepository.task(taskId(id)); if (!task.execution) throw new Error('任务尚未派发。');
    const error = await shell.openPath(task.execution.directory); if (error) throw new Error('无法打开任务目录。');
  });
  const emitVoice = (event: VoiceEvent) => { if (window && !window.isDestroyed()) window.webContents.send('voice:event', event); };
  const voice = new RealtimeVoice(event => room.acceptVoice(event), (name, args, context) => room.execute(name, args, context));
  room = new RoomService(history, agent, voice, interaction, workspace, state => {
    if (window && !window.isDestroyed()) window.webContents.send('room:state', state);
  }, emitVoice);
  let wake: WakeDetector | undefined;
  let voiceGeneration = 0;
  let wakePaused = false;
  const stopVoice = () => { voiceGeneration++; wake = undefined; room.stopVoice(); };
  handle('voice:start', async value => {
    if (typeof value !== 'boolean') throw new Error('Invalid voice mode');
    const generation = ++voiceGeneration;
    wake = undefined; room.stopVoice(false);
    if (process.platform === 'darwin' && !await systemPreferences.askForMediaAccess('microphone')) throw new Error('请在系统设置中允许 Orbit 使用麦克风。');
    if (generation !== voiceGeneration) return;
    if (value) {
      await room.abort();
      if (generation !== voiceGeneration) return;
      wake = new WakeDetector(resolve(__dirname, '../assets/voice')); emitVoice({ type: 'state', state: 'waiting' });
    } else await room.startVoice();
  });
  handle('voice:stop', stopVoice);
  handle('voice:audio', value => {
    if (!(value instanceof Uint8Array) || value.length > 8192 || value.length % 2) throw new Error('Invalid audio frame');
    if (wake) {
      if (!wakePaused && wake.accept(value)) { wake = undefined; window?.show(); return room.startVoice(); }
    } else room.audio(value);
  });
  app.on('before-quit', stopVoice);
  handle('workspace:read', () => workspace.snapshot());
  handle('conversation:read', () => agent.read());
  handle('room:read', page => room.read(page));
  handle('conversation:send', async input => {
    models.assertCanSend(); const prepared = interaction.prepare(input);
    const waiting = wake;
    if (waiting) { wakePaused = true; emitVoice({ type: 'state', state: 'paused' }); }
    try { await room.send(prepared); }
    finally { wakePaused = false; if (waiting && wake === waiting) emitVoice({ type: 'state', state: 'waiting' }); }
  });
  handle('conversation:abort', () => room.abort());
  handle('workspace:submit', input => { const result = workspace.submit(input); room.syncWorkspace(); return result; });
  handle('task:cancel', async id => { await execution.cancel(taskId(id)); room.syncWorkspace(); return workspace.snapshot(); });
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
      if (!quitting) { event.preventDefault(); window?.hide(); }
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
  void execution.start().catch(error => {
    executionStartupError = error instanceof Error ? error.message : '任务恢复失败。';
    const message = { id: 'execution-start-error-' + Date.now(), role: 'system', text: '后台任务恢复失败：' + executionStartupError, createdAt: new Date().toISOString() };
    db.prepare('INSERT INTO messages VALUES (?, ?, ?)').run(message.id, null, JSON.stringify(message));
    room.syncWorkspace();
  });
  app.on('activate', () => { if (!window) createWindow(); window!.show(); });
  let shutdownComplete = false;
  let shutdownStarted = false;
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void Promise.allSettled([room.close(), execution.close()]).finally(() => {
      if (shutdownComplete) return;
      shutdownComplete = true; db.close(); app.quit();
    });
  });
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
