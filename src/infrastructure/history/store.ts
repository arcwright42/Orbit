import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { rgPath } from '@vscode/ripgrep';
import type { Conversation, Message } from '../../contracts';
import { CONTEXT_POLICY, projectPiHistory, type Channel, type HistoryContext, type HistoryMessage, type HistoryPage, type HistoryPort } from '../../domains/conversation/history';

interface SessionInfo { id: string; channel: Channel; file: string; startedAt: string; providerSessionId?: string }
interface Manifest { version: 1; roomId: string; sessions: SessionInfo[]; policy: typeof CONTEXT_POLICY; migrated?: boolean }
const MAX_BYTES = 32768;
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(id);
function integer(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error('历史分页参数无效。');
  return Number(value);
}
function atomic(path: string, data: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 }); renameSync(temp, path);
}

/** The room transcript is authoritative; the manifest and in-memory index are rebuildable. */
export class FileRoomHistory implements HistoryPort {
  readonly directory: string;
  readonly historyDirectory: string;
  readonly runtimeDirectory: string;
  readonly roomId: string;
  private manifest: Manifest;
  private records = new Map<string, HistoryMessage>();
  private seq = 0;
  private blockedFiles = new Set<string>();
  warnings: string[] = [];

  constructor(dataDirectory: string, roomId = 'main') {
    if (!safeId(roomId)) throw new Error('Room 标识无效。');
    this.roomId = roomId;
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const root = realpathSync(dataDirectory);
    this.directory = resolve(root, 'rooms', roomId);
    this.historyDirectory = join(this.directory, 'history');
    this.runtimeDirectory = join(this.directory, 'runtime', 'pi');
    for (const dir of [join(root, 'rooms'), this.directory, this.historyDirectory, join(this.directory, 'runtime'), this.runtimeDirectory]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (lstatSync(dir).isSymbolicLink()) throw new Error('历史目录不能是符号链接。');
    }
    const manifestPath = join(this.directory, 'room.json');
    this.manifest = { version: 1, roomId, sessions: [], policy: CONTEXT_POLICY };
    if (existsSync(manifestPath)) {
      if (lstatSync(manifestPath).isSymbolicLink()) throw new Error('Room 文件不能是符号链接。');
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
        if (manifest.version !== 1 || manifest.roomId !== roomId || !Array.isArray(manifest.sessions) || manifest.sessions.some(session =>
          !safeId(session.id) || !/^[\w.-]+\.jsonl$/.test(session.file))) throw new Error('Invalid manifest');
        this.manifest = manifest;
      } catch {
        renameSync(manifestPath, `${manifestPath}.${randomUUID()}.corrupt`);
        this.warnings.push('Room 索引损坏，已备份并从历史文件重建。');
      }
    }
    for (const file of this.files().filter(file => file.endsWith('.jsonl'))) {
      const lines = readFileSync(this.path(file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as HistoryMessage;
          if (record.roomId !== roomId || !safeId(record.sessionId) || !Number.isSafeInteger(record.seq) || record.seq < 1 ||
              typeof record.id !== 'string' || typeof record.text !== 'string' || !['user', 'assistant', 'system', 'tool'].includes(record.role) ||
              typeof record.turnId !== 'string' || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
              !['text', 'voice', 'system'].includes(record.channel) || !['running', 'complete', 'interrupted', 'failed'].includes(record.status) ||
              (record.tool !== undefined && (typeof record.tool?.name !== 'string' || typeof record.tool?.input !== 'string'))) throw new Error();
          this.records.set(record.id, record); this.seq = Math.max(this.seq, record.seq);
          if (!this.manifest.sessions.some(session => session.id === record.sessionId)) {
            this.manifest.sessions.push({ id: record.sessionId, channel: record.channel, file, startedAt: record.createdAt });
          }
        } catch {
          this.blockedFiles.add(file);
          const warning = `历史文件 ${file} 含损坏记录，已保留原文件与可恢复内容。`;
          if (!this.warnings.includes(warning)) this.warnings.push(warning);
        }
      }
    }
    this.saveManifest();
    // A previous host can no longer finish these calls. Keep their identity and ordering.
    for (const record of this.records.values()) {
      if (record.role === 'tool' && record.status === 'running') this.append({ ...record, status: 'interrupted' }, record.sessionId, record.channel);
    }
  }

  private saveManifest() { atomic(join(this.directory, 'room.json'), JSON.stringify(this.manifest, null, 2) + '\n'); }
  private files() { return readdirSync(this.historyDirectory).filter(name => /^[\w.-]+\.(jsonl|summary\.md)$/.test(name)).sort(); }
  private path(file: string) {
    if (basename(file) !== file || !this.files().includes(file)) throw new Error('历史文件不存在或不属于当前 room。');
    const path = join(this.historyDirectory, file);
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error('历史文件路径无效。');
    return path;
  }

  session(id: string, channel: Channel, startedAt = new Date().toISOString()): SessionInfo {
    if (!safeId(id) || !Number.isFinite(Date.parse(startedAt))) throw new Error('Session 标识或时间无效。');
    let session = this.manifest.sessions.find(item => item.id === id);
    if (!session) {
      session = { id, channel, startedAt, file: `${new Date(startedAt).toISOString().replace(/:/g, '-')}--${channel === 'text' ? 'pi' : channel === 'voice' ? 'qwen' : 'system'}--${id}.jsonl` };
      this.manifest.sessions.push(session); this.saveManifest();
    }
    return session;
  }
  bindProvider(id: string, providerSessionId: string) {
    const session = this.manifest.sessions.find(item => item.id === id);
    if (session && session.providerSessionId !== providerSessionId) { session.providerSessionId = providerSessionId; this.saveManifest(); }
  }
  append(message: Message, sessionId: string, channel: Channel): HistoryMessage {
    const previous = this.records.get(message.id);
    const session = this.session(sessionId, channel, message.createdAt);
    const record: HistoryMessage = { ...message, createdAt: previous?.createdAt ?? message.createdAt, roomId: this.roomId, sessionId, channel,
      turnId: message.turnId ?? message.requestId ?? message.id, status: message.status ?? 'complete', seq: previous?.seq ?? this.seq + 1 };
    if (previous && JSON.stringify(previous) === JSON.stringify(record)) return previous;
    // Never append behind a torn line: retain the damaged segment and continue in a new file.
    if (this.blockedFiles.has(session.file)) {
      session.file = `${new Date().toISOString().replace(/:/g, '-')}--recovered--${session.id}.jsonl`;
      this.saveManifest();
    }
    const path = join(this.historyDirectory, session.file);
    if (existsSync(path)) this.path(session.file);
    const fd = openSync(path, 'a', 0o600);
    try { appendFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    this.records.set(record.id, record); this.seq = Math.max(this.seq, record.seq);
    return record;
  }
  importPi(state: Conversation) {
    if (!state.sessionId) return;
    for (const message of state.messages) this.append(message, state.sessionId, 'text');
    if (state.summary) this.summary(state.sessionId, state.summary.text, state.summary.throughEntryId);
  }
  summary(sessionId: string, text: string, source: string) {
    if (!safeId(sessionId)) throw new Error('Session 标识无效。');
    const file = `${sessionId}.summary.md`;
    const body = `# Session ${sessionId}\n\n这是模型生成的压缩摘要，不是原始消息。来源条目：${source}\n\n${text}\n`;
    if (existsSync(join(this.historyDirectory, file))) {
      if (readFileSync(this.path(file), 'utf8') === body) return;
    }
    atomic(join(this.historyDirectory, file), body);
  }
  all() { return [...this.records.values()].sort((a, b) => a.seq - b.seq); }
  has(id: string) { return this.records.has(id); }
  page(before?: unknown, limit?: unknown): HistoryPage {
    const count = integer(limit, 100, 200);
    const boundary = before === undefined ? Infinity : integer(before, 1, Number.MAX_SAFE_INTEGER);
    const all = this.all().filter(message => message.seq < boundary);
    const messages = all.slice(-count);
    return { messages, ...(all.length > count ? { nextCursor: messages[0].seq } : {}) };
  }
  context(): HistoryContext {
    // Native Pi/Qwen already receive tool results. The shared context contains speech/text only.
    const all = this.all().filter(message => message.role === 'user' || message.role === 'assistant');
    const messages: HistoryMessage[] = []; const turns = new Set<string>(); let bytes = 0;
    for (const message of all.reverse()) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (!turns.has(message.turnId) && turns.size >= CONTEXT_POLICY.recentTurns) break;
      if (bytes + size > CONTEXT_POLICY.recentBytes) {
        const budget = CONTEXT_POLICY.recentBytes - bytes - Buffer.byteLength(JSON.stringify({ ...message, text: '' })) - 256;
        if (budget > 256) {
          let text = '', used = 0;
          for (const char of message.text) { const n = Buffer.byteLength(JSON.stringify(char)) - 2; if (used + n > budget) break; text += char; used += n; }
          messages.unshift({ ...message, text: text + '\n[历史摘录已截断；完整内容请使用 search_history / read_history。]' });
        }
        break;
      }
      turns.add(message.turnId); messages.unshift(message); bytes += size;
    }
    return { roomId: this.roomId, throughSeq: this.seq, messages };
  }
  attachments() { return [...new Set(this.all().flatMap(message => message.attachmentIds ?? []))]; }

  migrate(legacyDirectory: string, receipts: Message[]) {
    if (this.manifest.migrated) return;
    const sessionsDirectory = join(legacyDirectory, 'sessions');
    const imported: { message: Message; session: string; channel: Channel }[] = [];
    if (existsSync(sessionsDirectory)) {
      const target = join(this.runtimeDirectory, 'sessions'); mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const file of readdirSync(sessionsDirectory).filter(file => file.endsWith('.jsonl'))) {
        const original = join(sessionsDirectory, file);
        if (lstatSync(original).isSymbolicLink()) continue;
        const entries = [];
        let damaged = false;
        for (const line of readFileSync(original, 'utf8').split('\n').filter(Boolean)) {
          try { entries.push(JSON.parse(line)); } catch { damaged = true; }
        }
        const sessionId = entries.find(entry => entry.type === 'session')?.id;
        if (!sessionId || !safeId(sessionId)) continue;
        if (!damaged && !existsSync(join(target, file))) {
          // Pi filters recent-session discovery by header cwd. Relocate the copy, retaining IDs and source timestamps.
          const destination = join(target, file);
          atomic(destination, entries.map(entry => JSON.stringify(entry.type === 'session' ? { ...entry, cwd: this.runtimeDirectory } : entry)).join('\n') + '\n');
          const stat = statSync(original); utimesSync(destination, stat.atime, stat.mtime);
        }
        if (damaged) this.warnings.push(`旧 Pi 文件 ${file} 含损坏记录，已迁移可读消息；原始文件保留，运行会话重新建立。`);
        const byId = new Map(entries.filter(entry => entry.id).map(entry => [entry.id, entry]));
        const branch = []; let current = entries.at(-1); const seen = new Set<string>();
        while (current?.id && !seen.has(current.id)) { seen.add(current.id); branch.unshift(current); current = byId.get(current.parentId); }
        for (const message of projectPiHistory(branch, sessionId)) imported.push({ message, session: sessionId, channel: 'text' });
      }
    }
    for (const message of receipts) imported.push({ message, session: 'legacy-workspace', channel: 'system' });
    imported.sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt) || a.message.id.localeCompare(b.message.id));
    for (const item of imported) this.append(item.message, item.session, item.channel);
    this.manifest.migrated = true; this.saveManifest();
  }

  async readHistory(args: Record<string, unknown>) {
    if (typeof args.file !== 'string') throw new Error('请提供历史文件名。');
    const path = this.path(args.file); const limit = integer(args.limit, 50, 200);
    let line = integer(args.fromLine, 1, Number.MAX_SAFE_INTEGER), column = 0;
    if (args.cursor !== undefined) {
      if (args.fromLine !== undefined || typeof args.cursor !== 'string' || !/^\d+:\d+$/.test(args.cursor)) throw new Error('历史读取游标无效。');
      [line, column] = args.cursor.split(':').map(Number);
      integer(line, 1, Number.MAX_SAFE_INTEGER); if (!Number.isSafeInteger(column)) throw new Error('历史读取游标无效。');
    }
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const output: { line: number; text: string }[] = []; let size = 0, index = 0, nextCursor: string | undefined;
    try {
      for await (const source of lines) {
        index++;
        if (index < line) continue;
        if (output.length >= limit) { nextCursor = `${index}:0`; break; }
        if (column > source.length) throw new Error('历史读取游标无效。');
        let fragment = ''; size += 48;
        for (const char of source.slice(column)) {
          const bytes = Buffer.byteLength(JSON.stringify(char)) - 2;
          if (size + bytes > MAX_BYTES - 2048) break;
          fragment += char; size += bytes;
        }
        output.push({ line: index, text: fragment }); column += fragment.length;
        if (column < source.length) { nextCursor = `${index}:${column}`; break; }
        column = 0;
      }
    } finally { lines.close(); stream.destroy(); }
    return { file: args.file, lines: output, ...(nextCursor ? { truncated: true, nextCursor } : {}), warnings: this.warnings.slice(0, 3) };
  }

  async searchHistory(args: Record<string, unknown>): Promise<unknown> {
    if (!['files', 'content'].includes(String(args.mode)) || typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > 1024 || args.pattern.includes('\0')) throw new Error('历史检索参数无效。');
    if (args.glob !== undefined && (typeof args.glob !== 'string' || args.glob.includes('/') || args.glob.includes('\\'))) throw new Error('文件过滤参数无效。');
    if (args.mode === 'files' && /[/\\]/.test(args.pattern)) throw new Error('文件查找只能使用文件名。');
    const limit = integer(args.limit, 20, 100);
    // Validate every candidate before launching rg; it never follows links or searches runtime files.
    for (const file of this.files()) this.path(file);
    // Explicit safe candidates keep globs from widening the root or including runtime files.
    const { matchesGlob } = await import('node:path');
    const candidates = this.files().filter(file => (!args.glob || matchesGlob(file, String(args.glob))) &&
      (args.mode !== 'files' || matchesGlob(file, args.pattern as string)));
    if (args.mode === 'files') return { matches: candidates.slice(0, limit).map(file => ({ file })), truncated: candidates.length > limit, warnings: this.warnings.slice(0, 3) };
    if (!candidates.length) return { matches: [], truncated: false, warnings: this.warnings.slice(0, 3) };
    const command = ['--json', '--line-number', '--max-columns', '1000000', '--no-config', '--color=never'];
    if (args.mode === 'content') {
      if (args.literal !== false) command.push('--fixed-strings');
      if (args.ignoreCase === true) command.push('--ignore-case');
      command.push('--', args.pattern, ...candidates);
    }
    return new Promise((resolveResult, reject) => {
      const child = spawn(rgPath, command, { cwd: this.historyDirectory, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const matches: unknown[] = []; let pending = '', bytes = 0, truncated = false, timedOut = false, malformed = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 5000);
      child.stdout.setEncoding('utf8'); child.stderr.resume();
      child.stdout.on('data', (chunk: string) => {
        if (truncated) return;
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          let match: unknown;
          {
            let event;
            try { event = JSON.parse(line); } catch { malformed = true; child.kill(); break; }
            if (event.type !== 'match') continue;
            const start = event.data.submatches?.[0]?.start ?? 0;
            const text = event.data.lines.text as string;
            const prefix = Buffer.from(text).subarray(0, start).toString('utf8').length;
            match = { file: basename(event.data.path.text), line: event.data.line_number, excerpt: text.slice(Math.max(0, prefix - 100), prefix + 500).trim() };
          }
          const length = Buffer.byteLength(JSON.stringify(match));
          if (matches.length >= limit || bytes + length > MAX_BYTES - 2048) { truncated = true; child.kill(); break; }
          matches.push(match); bytes += length;
        }
      });
      child.on('error', () => { clearTimeout(timer); reject(new Error('历史检索组件无法启动，请重新构建或安装 Orbit。')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) reject(new Error('历史检索超时，请缩小文件范围或使用更具体的词。'));
        else if (malformed || code !== 0 && code !== 1 && !truncated) reject(new Error('历史检索失败，请检查正则表达式。'));
        else resolveResult({ matches, truncated, warnings: this.warnings.slice(0, 3) });
      });
    });
  }
}
