import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { defaultTeamConfig, validateTeamConfig, type TeamConfig } from '../workflows/spec';
import { transaction } from '../../infrastructure/database';
export interface Seat { id: string; teamId: string; role: string; name: string; sessionId: string; nativeId: string | null; runtime: 'codex'; generation: string; workspace: string; instructions: string; model?: string }
export interface LocalTeam { id: string; name: string; workspace: string; seats: Seat[]; contextPack?: string; config: TeamConfig }
/** Session, node and native runtime identity are separate persisted facts. */
export class TeamRegistry {
  constructor(private db: DatabaseSync, private root: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS orbit_teams (id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace TEXT NOT NULL,context_pack TEXT);
      CREATE TABLE IF NOT EXISTS orbit_seats (id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES orbit_teams(id),role TEXT NOT NULL,name TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE,native_id TEXT,runtime TEXT NOT NULL,generation TEXT NOT NULL,workspace TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orbit_task_sessions (session_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,seat_id TEXT NOT NULL REFERENCES orbit_seats(id),native_id TEXT,generation TEXT NOT NULL,workspace TEXT NOT NULL,UNIQUE(task_id,seat_id));
      CREATE TABLE IF NOT EXISTS orbit_edges (source_id TEXT NOT NULL REFERENCES orbit_seats(id),target_id TEXT NOT NULL REFERENCES orbit_seats(id),kind TEXT NOT NULL,PRIMARY KEY(source_id,target_id,kind));`);
    this.db.exec('CREATE TABLE IF NOT EXISTS team_create_requests (request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, team_id TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS orbit_team_configs (team_id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  }
  create(name: string, input: unknown = defaultTeamConfig, requestId?: string): LocalTeam {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('团队名称应为 1–80 字符。');
    const config = validateTeamConfig(input);
    const payload = JSON.stringify({ name, config });
    if (requestId) { const existing = this.db.prepare('SELECT * FROM team_create_requests WHERE request_id=?').get(requestId); if (existing) { if (existing.payload !== payload) throw new Error('创建团队请求 ID 已用于不同配置'); return this.require(String(existing.team_id)); } }
    const id = randomUUID(), workspace = join(this.root, id); mkdirSync(workspace, { recursive: true });
    return transaction(this.db, () => {
      this.db.prepare('INSERT INTO orbit_teams VALUES (?,?,?,NULL)').run(id, name.trim(), workspace);
      const ids: string[] = [];
      for (const member of config.members) {
        const { role } = member;
        const node = randomUUID(); ids.push(node);
        this.db.prepare('INSERT INTO orbit_seats VALUES (?,?,?,?,?,NULL,?,?,?)').run(node, id, role, member.name, randomUUID(), 'codex', randomUUID(), workspace);
      }
      for (const edge of config.edges) this.db.prepare('INSERT OR IGNORE INTO orbit_edges VALUES (?,?,?)').run(ids[config.members.findIndex(m => m.role === edge.from)], ids[config.members.findIndex(m => m.role === edge.to)], 'collaborates_with');
      this.db.prepare('INSERT INTO orbit_team_configs VALUES (?,?)').run(id, JSON.stringify(config));
      if (requestId) this.db.prepare('INSERT INTO team_create_requests VALUES (?,?,?)').run(requestId, payload, id);
      return this.require(id);
    });
  }
  list(): LocalTeam[] { return this.db.prepare('SELECT id FROM orbit_teams ORDER BY rowid').all().map(row => this.require(String(row.id))); }
  require(id: string): LocalTeam {
    const row = this.db.prepare('SELECT * FROM orbit_teams WHERE id=?').get(id); if (!row) throw new Error('团队不存在。');
    return { id, config: this.config(id), name: String(row.name), workspace: String(row.workspace), contextPack: row.context_pack ? String(row.context_pack) : undefined, seats: this.db.prepare('SELECT * FROM orbit_seats WHERE team_id=? ORDER BY rowid').all(id).map(decode) };
  }
  seat(sessionId: string): Seat { const row = this.db.prepare('SELECT s.id,s.team_id,s.role,s.name,t.session_id,t.native_id,s.runtime,t.generation,t.workspace FROM orbit_task_sessions t JOIN orbit_seats s ON s.id=t.seat_id WHERE t.session_id=?').get(sessionId) ?? this.db.prepare('SELECT * FROM orbit_seats WHERE session_id=?').get(sessionId); if (!row) throw new Error('执行会话没有绑定成员。'); return { ...decode(row), ...this.config(String(row.team_id)).members.find(m => m.role === row.role) }; }
  bindNative(sessionId: string, generation: string, nativeId: string) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(nativeId)) throw new Error('Invalid native session identity');
    if (!this.db.prepare('UPDATE orbit_task_sessions SET native_id=? WHERE session_id=? AND generation=?').run(nativeId, sessionId, generation).changes) throw new Error('Session generation changed');
  }
  taskSeats(teamId: string, taskId: string, directory?: string): Seat[] {
    const team = this.require(teamId); let workspace = join(team.workspace, 'tasks', taskId);
    if (directory !== undefined) { if (!isAbsolute(directory) || !statSync(directory).isDirectory()) throw new Error('请选择已有的绝对目录路径'); workspace = realpathSync(directory); }
    else mkdirSync(workspace, { recursive: true });
    return team.seats.map(seat => {
      const existing = this.db.prepare('SELECT session_id FROM orbit_task_sessions WHERE task_id=? AND seat_id=?').get(taskId, seat.id);
      if (existing) { const seat = this.seat(String(existing.session_id)); if (directory && seat.workspace !== workspace) throw new Error('执行开始后不能更换工作目录'); return seat; }
      const sessionId = randomUUID();
      this.db.prepare('INSERT INTO orbit_task_sessions VALUES (?,?,?,NULL,?,?)').run(sessionId, taskId, seat.id, randomUUID(), workspace);
      return this.seat(sessionId);
    });
  }
  config(teamId: string): TeamConfig { const row = this.db.prepare('SELECT payload FROM orbit_team_configs WHERE team_id=?').get(teamId); return row ? JSON.parse(String(row.payload)) : structuredClone(defaultTeamConfig); }
  seatRoot(seat: Seat) { return join(this.require(seat.teamId).workspace, 'knowledge', seat.id); }
  targets(seat: Seat, taskId: string): Seat[] { const allowed = new Set(this.config(seat.teamId).edges.filter(e => e.from === seat.role).map(e => e.to)); return this.taskSeats(seat.teamId, taskId).filter(s => allowed.has(s.role)); }
  rotate(sessionId: string) { const seat = this.seat(sessionId); this.db.prepare('UPDATE orbit_task_sessions SET native_id=NULL,generation=? WHERE session_id=?').run(randomUUID(), seat.sessionId); }
  contextPack(teamId: string, directory: string) { this.require(teamId); this.db.prepare('UPDATE orbit_teams SET context_pack=? WHERE id=?').run(directory, teamId); }
}
function decode(row: Record<string, unknown>): Seat { return { instructions: '', id: String(row.id), teamId: String(row.team_id), role: row.role as Seat['role'], name: String(row.name), sessionId: String(row.session_id), nativeId: row.native_id ? String(row.native_id) : null, runtime: 'codex', generation: String(row.generation), workspace: String(row.workspace) }; }
