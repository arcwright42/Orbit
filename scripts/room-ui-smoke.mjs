// Offline renderer integration: real Electron/preload/Room/Pi, synthetic mic and controlled voice state events.
// Qwen transport and real cross-channel context have separate protocol/live tests.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelServer } from '../tests/fixtures/model-server.ts';
const directory = await mkdtemp(join(tmpdir(), 'orbit-room-ui-'));
const model = await createModelServer();
const env = { ...process.env, ...model.env, ORBIT_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE; delete env.ORBIT_DEV_URL;
let app, page;
const errors = [];
try {
  const history = join(directory, 'rooms/main/history'); await mkdir(history, { recursive: true }); await mkdir('artifacts', { recursive: true });
  const messages = Array.from({ length: 160 }, (_, i) => ({
    id: `seed-${i + 1}`, roomId: 'main', sessionId: 'seed-voice', turnId: `turn-${Math.floor(i / 2)}`, seq: i + 1,
    role: i % 2 === 0 ? 'user' : 'assistant', channel: 'voice', status: i === 159 ? 'interrupted' : 'complete',
    text: `历史对话 ${String(i + 1).padStart(3, '0')}`, createdAt: new Date(Date.UTC(2026, 9, 18, 8, i)).toISOString(),
  }));
  await writeFile(join(history, '2026-10-18T08-00-00.000Z--qwen--seed-voice.jsonl'), messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  app = await electron.launch({ args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByText('历史对话 160', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-message-id]').count(), 100);
  assert.equal(await page.getByText('已中断', { exact: true }).count(), 1);
  const older = page.getByRole('button', { name: '加载更早的对话' }); await older.scrollIntoViewIfNeeded();
  const beforeTop = await page.locator('[data-message-id="seed-61"]').evaluate(element => element.getBoundingClientRect().top);
  await older.click(); await page.getByText('历史对话 001', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-message-id]').count(), 160);
  const afterTop = await page.locator('[data-message-id="seed-61"]').evaluate(element => element.getBoundingClientRect().top);
  assert.ok(Math.abs(beforeTop - afterTop) < 5, `Reading position moved: ${beforeTop} -> ${afterTop}`);
  await page.getByRole('textbox', { name: '你的需求' }).fill('保存一个网站需求');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('需求已保存在本机，尚未派发。', { exact: false }).waitFor();
  assert.equal(await page.getByText('历史对话 001', { exact: true }).count(), 1, 'Live page must not replace loaded archive');
  assert.equal(await page.getByText('需求已保存在本机，尚未派发。', { exact: false }).count(), 1, 'Receipt must not duplicate');
  await expect(page.getByRole('textbox', { name: '你的需求' })).toHaveValue('');
  await page.screenshot({ path: 'artifacts/orbit-room-timeline.png' });
  // Controlled voice transport uses the actual preload subscription and AudioWorklet.
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    globalThis.roomUiTest = { starts: 0, frames: 0, blockFrame: false, rejectFrame: null };
    for (const channel of ['voice:start', 'voice:stop', 'voice:audio']) ipcMain.removeHandler(channel);
    ipcMain.handle('voice:start', async () => {
      globalThis.roomUiTest.starts++;
      await win.webContents.executeJavaScript('window.orbit.stopReply()');
      win.webContents.send('voice:event', { type: 'state', state: 'listening' });
    });
    ipcMain.handle('voice:stop', () => win.webContents.send('voice:event', { type: 'state', state: 'off' }));
    ipcMain.handle('voice:audio', () => {
      globalThis.roomUiTest.frames++;
      if (globalThis.roomUiTest.blockFrame) {
        globalThis.roomUiTest.blockFrame = false;
        return new Promise((_resolve, reject) => { globalThis.roomUiTest.rejectFrame = reject; });
      }
    });
  });
  await page.evaluate(() => {
    window.testStreams = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async input => { const stream = await getUserMedia(input); window.testStreams.push(stream); return stream; };
  });
  await page.getByRole('button', { name: '开始语音', exact: true }).click();
  await page.getByText('正在聆听', { exact: true }).waitFor();
  await expect.poll(() => app.evaluate(() => globalThis.roomUiTest.frames)).toBeGreaterThan(0);
  assert.equal(await page.evaluate(() => window.testStreams.at(-1).getAudioTracks()[0].enabled), true);
  await page.getByRole('textbox', { name: '你的需求' }).fill('慢回复');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('正在等待测试中断', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('voice:event', { type: 'state', state: 'paused' }));
  await page.getByText('文字回复中 · 麦克风已暂停', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.testStreams.at(-1).getAudioTracks()[0].enabled), false);
  const pausedFrames = await app.evaluate(() => globalThis.roomUiTest.frames);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await app.evaluate(() => globalThis.roomUiTest.frames), pausedFrames);
  await page.screenshot({ path: 'artifacts/orbit-room-paused.png' });
  await page.getByRole('button', { name: '停止文字，切回语音', exact: true }).click();
  await page.getByText('正在聆听', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.orbit.room.read())).status, 'idle');
  assert.equal(await page.evaluate(() => window.testStreams.at(-1).getAudioTracks()[0].enabled), true);
  assert.equal(await page.evaluate(() => window.testStreams.length), 1, 'Resume must reuse the microphone');
  await app.evaluate(() => { globalThis.roomUiTest.blockFrame = true; });
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.roomUiTest.rejectFrame))).toBe(true);
  await page.getByRole('button', { name: '结束语音', exact: true }).last().click();
  assert.equal(await page.evaluate(() => window.testStreams.at(-1).getAudioTracks()[0].readyState), 'ended');
  await page.getByRole('button', { name: '开始语音', exact: true }).click();
  await page.getByText('正在聆听', { exact: true }).waitFor();
  await app.evaluate(() => globalThis.roomUiTest.rejectFrame(new Error('Synthetic late audio failure')));
  await new Promise(resolve => setTimeout(resolve, 100));
  await expect(page.getByText('正在聆听', { exact: true })).toBeVisible();
  assert.equal(await page.getByText('音频传输失败，请重试。', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '结束语音', exact: true }).last().click();
  assert.deepEqual(errors, []);
  console.log('Room UI smoke passed: unified archive, paging/scroll anchor, receipt dedup, live-page merge, paused mic and audio gate, manual voice switch, stale audio errors, resource release.');
} catch (error) {
  if (page) await page.screenshot({ path: 'artifacts/orbit-room-ui-failure.png' }).catch(() => {});
  throw error;
} finally { if (app) await app.close(); await model.close(); await rm(directory, { recursive: true, force: true }); }
