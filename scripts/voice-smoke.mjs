// Opt-in integration test: uses local .env and a synthetic microphone, never the real microphone.
import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const dir = await mkdtemp(join(tmpdir(), 'orbit-voice-test-'));
const env = { ...process.env, ORBIT_DATA_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE; delete env.ORBIT_DEV_URL;
let app;
try {
  app = await electron.launch({ args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env });
  const page = await app.firstWindow(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: '开始语音', exact: true }).click();
  await page.getByText('正在聆听', { exact: true }).waitFor({ timeout: 25000 });
  await page.getByRole('button', { name: '结束语音', exact: true }).last().click();
  await page.getByRole('button', { name: '开始语音', exact: true }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '开启语音唤醒' }).click();
  await page.getByText('等待唤醒 · Hey Orbit', { exact: true }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: 'artifacts/orbit-voice.png' });
  await page.getByRole('button', { name: '结束语音', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('Voice UI smoke passed: fake microphone, official realtime session, stop, local wake initialization.');
} finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
