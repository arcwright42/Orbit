import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Attachment } from '../../contracts';

const MAX_BYTES = 25 * 1024 * 1024;
const EXTENSIONS = new Set(['.txt', '.md', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.docx', '.csv']);

export class MaterialLibrary {
  constructor(private db: DatabaseSync, private directory: string) {}

  list(): Attachment[] {
    return this.db.prepare('SELECT payload FROM attachments ORDER BY rowid DESC').all()
      .map(row => JSON.parse(String(row.payload)) as Attachment);
  }

  require(id: string): { attachment: Attachment; path: string } {
    const row = this.db.prepare('SELECT payload, stored_path FROM attachments WHERE id = ?').get(id);
    if (!row) throw new Error('附件不存在，请重新选择。');
    return { attachment: JSON.parse(String(row.payload)), path: String(row.stored_path) };
  }

  async importFile(source: string): Promise<Attachment> {
    if (!EXTENSIONS.has(extname(source).toLowerCase())) throw new Error('暂不支持该附件格式。');
    const file = await open(source, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('请选择 25 MB 以内的普通文件。');
      // Bound the read even if a source file grows after stat().
      const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset > stat.size) throw new Error('文件正在变化，请稍后重新添加。');
      const attachment: Attachment = { id: randomUUID(), name: basename(source), size: offset, createdAt: new Date().toISOString() };
      await mkdir(this.directory, { recursive: true });
      const path = join(this.directory, attachment.id + extname(source).toLowerCase());
      const target = await open(path, 'wx', 0o600);
      try { await target.writeFile(bytes.subarray(0, offset)); } finally { await target.close(); }
      try {
        this.db.prepare('INSERT INTO attachments VALUES (?, ?, ?)').run(attachment.id, JSON.stringify(attachment), path);
      } catch (error) {
        await unlink(path);
        throw error;
      }
      return attachment;
    } finally { await file.close(); }
  }
}
