import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { RealtimeVoice } from '../domains/voice/realtime';
import { WakeDetector } from '../domains/voice/wake';
import type { VoiceEvent } from '../contracts';
import { systemPreferences, app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../infrastructure/database';
import { MaterialLibrary } from '../domains/materials/library';
import { WorkspaceService } from '../application/workspace';

try { loadEnvFile(resolve(__dirname, '../.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
app.setName('Orbit');
if (process.env.ORBIT_DATA_DIR) app.setPath('userData', resolve(process.env.ORBIT_DATA_DIR));
const dataDir = app.getPath('userData');
mkdirSync(dataDir, { recursive: true });
let window: BrowserWindow | null = null;
let quitting = false;
const devUrl = !app.isPackaged ? process.env.ORBIT_DEV_URL : undefined;
if (devUrl && devUrl !== 'http://127.0.0.1:5173') throw new Error('Unexpected development URL');
const indexPath = join(__dirname, '../dist/index.html');
const trustedUrl = devUrl ?? pathToFileURL(indexPath).href;

app.whenReady().then(() => {
  const db = openDatabase(join(dataDir, 'orbit.sqlite'));
  const materials = new MaterialLibrary(db, join(dataDir, 'attachments'));
  const workspace = new WorkspaceService(db, materials);
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url.split('#')[0] !== trustedUrl && event.senderFrame.url.split('#')[0] !== `${trustedUrl}/`) {
        throw new Error('Untrusted IPC sender');
      }
      return action(...args);
    });
  };
  const emitVoice = (event: VoiceEvent) => { if (window && !window.isDestroyed()) window.webContents.send('voice:event', event); };
  const voice = new RealtimeVoice(emitVoice, (name, args) => {
    if (name === 'list_tasks') return workspace.snapshot().tasks.map(({ id, title, status }) => ({ id, title, status }));
    if (name === 'save_request' && args && typeof args === 'object' && 'text' in args && typeof args.text === 'string') {
      const requestId = randomUUID();
      const snapshot = workspace.submit({ requestId, text: args.text, attachmentIds: [] });
      return { task: snapshot.tasks.find(task => task.requestId === requestId), executed: false };
    }
    throw new Error('Unsupported tool');
  });
  let wake: WakeDetector | undefined;
  let voiceGeneration = 0;
  const stopVoice = () => { voiceGeneration++; wake = undefined; voice.stop(); };
  handle('voice:start', async value => {
    if (typeof value !== 'boolean') throw new Error('Invalid voice mode');
    const generation = ++voiceGeneration;
    wake = undefined; voice.stop(false);
    if (process.platform === 'darwin' && !await systemPreferences.askForMediaAccess('microphone')) throw new Error('请在系统设置中允许 Orbit 使用麦克风。');
    if (generation !== voiceGeneration) return;
    if (value) { wake = new WakeDetector(resolve(__dirname, '../assets/voice')); emitVoice({ type: 'state', state: 'waiting' }); }
    else voice.start();
  });
  handle('voice:stop', stopVoice);
  handle('voice:audio', value => {
    if (!(value instanceof Uint8Array) || value.length > 8192 || value.length % 2) throw new Error('Invalid audio frame');
    if (wake) { if (wake.accept(value)) { wake = undefined; window?.show(); voice.start(); } }
    else voice.audio(value);
  });
  app.on('before-quit', stopVoice);
  handle('workspace:read', () => workspace.snapshot());
  handle('workspace:submit', input => workspace.submit(input));
  handle('task:cancel', id => workspace.cancelTask(id));
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
  app.on('will-quit', () => db.close());
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
