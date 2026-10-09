import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../../infrastructure/database';
import { defaultTeamConfig, validateTeamConfig, type TeamConfig } from '../workflows/spec';

export interface TeamTemplate { id: string; name: string; description: string; revision: number; builtin: boolean; config: TeamConfig }
const builtins: TeamTemplate[] = [
  { id: 'build-review', name: '执行与检查', description: '执行、独立检查、不通过返工，最后由用户验收。', revision: 1, builtin: true, config: defaultTeamConfig },
  { id: 'parallel-research', name: '并行调研', description: '资料调研和方案分析并行，汇总角色等待两者完成后交付。', revision: 1, builtin: true, config: {
    members: [
      { role: 'researcher', name: '资料调研', instructions: '查找并核验资料，保留来源和不确定性。' },
      { role: 'analyst', name: '方案分析', instructions: '独立分析方案、限制与取舍，形成有依据的建议。' },
      { role: 'editor', name: '汇总', instructions: '核对前两位成员的结果，整合交付，不编造证据。' },
    ], edges: [{ from: 'researcher', to: 'editor' }, { from: 'analyst', to: 'editor' }],
    workflow: { entry: 'research', max_hops: 24, steps: [
      { id: 'research', actor_role: 'researcher', objective: '调研需求相关资料并保存来源。', depends_on: [] },
      { id: 'analysis', actor_role: 'analyst', objective: '分析需求对应的方案与取舍。', depends_on: [] },
      { id: 'synthesis', actor_role: 'editor', objective: '汇总资料和分析结果，核对引用与结论。', depends_on: ['research','analysis'] },
    ] },
  } },
];
export class TeamTemplates {
  constructor(private db: DatabaseSync) { db.exec('CREATE TABLE IF NOT EXISTS team_templates (id TEXT PRIMARY KEY, payload TEXT NOT NULL)'); }
  list(query = '') { if (typeof query !== 'string' || query.length > 200) throw new Error('Invalid template query'); return [...builtins, ...this.db.prepare('SELECT payload FROM team_templates ORDER BY id').all().map(row => JSON.parse(String(row.payload)) as TeamTemplate)]
    .filter(t => `${t.id} ${t.name} ${t.description}`.toLowerCase().includes(query.toLowerCase()))
    .map(t => ({ id: t.id, name: t.name, description: t.description, revision: t.revision, builtin: t.builtin, roles: t.config.members.map(m => ({ role: m.role, name: m.name })), runtime: 'codex' as const })); }
  get(id: string): TeamTemplate { const builtin = builtins.find(t => t.id === id); if (builtin) return structuredClone(builtin); const row = this.db.prepare('SELECT payload FROM team_templates WHERE id=?').get(id); if (!row) throw new Error('团队模板不存在'); return JSON.parse(String(row.payload)); }
  save(input: { id: string; name: string; description: string; config: unknown; expectedRevision: number }): TeamTemplate {
    if (!input || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(input.id) || builtins.some(t => t.id === input.id)) throw new Error('Invalid or built-in template id');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || typeof input.description !== 'string' || input.description.length > 2000 || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('Invalid template metadata');
    const config = validateTeamConfig(input.config);
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT payload FROM team_templates WHERE id=?').get(input.id), revision = row ? (JSON.parse(String(row.payload)) as TeamTemplate).revision : 0;
      if (revision !== input.expectedRevision) throw new Error('模板版本已变化，请重新查询后更新');
      const template: TeamTemplate = { id: input.id, name: input.name.trim(), description: input.description, config, builtin: false, revision: revision + 1 };
      this.db.prepare('INSERT INTO team_templates VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(input.id, JSON.stringify(template)); return template;
    });
  }
}
