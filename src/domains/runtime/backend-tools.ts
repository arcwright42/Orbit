import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { StartupProof } from './startup-proof';

export interface BackendTool { name: string; description: string; input: Record<string, string> }
export const backendTools: BackendTool[] = [
  { name:'startup_proof',description:'按当前启动挑战提交上下文接收回执；READY 不是核验。只有当前执行凭证、会话及代次有效。',input:{challengeId:'当前挑战 ID',answer:'启动文本中的精确 answer',sessionId:'启动挑战中的执行会话 ID',generation:'启动挑战中的席位代次'} },
  { name:'read_context',description:'启动、交接或原生压缩后重新读取当前上下文 profile、席位记录与团队经验',input:{} },
  { name:'write_recap',description:'立即持久化当前席位交接记录及可选团队经验，不结束义务；在交接、等待、压缩前保存进度和决定',input:{recap:'Markdown 交接记录，保留关键决定与理由',lessons:'可选团队经验，不含凭证'} },
  { name: 'list_work', description: '查询当前任务的执行义务与真实状态，不跨任务', input: { after: '可选队列偏移', limit: '1–100，默认20' } },
  { name: 'get_work', description: '读取同一任务的一个义务及其上下文', input: { itemId: '义务 ID，默认当前义务' } },
  { name: 'get_team', description: '查询本团队角色及允许交接的成员', input: {} },
  { name: 'search_team_memory', description: '检索本团队经验及来源', input: { query: '检索词' } },
  { name: 'read_team_memory', description: '读取本团队一条经验原文', input: { memoryId: '经验 ID' } },
  { name: 'report_progress', description: '记录可核查的当前进度，不代表完成', input: { note: '进展及证据' } },
  { name: 'handoff_work', description: '准备交接当前义务；结束本轮后才生效', input: { acceptance: '验收契约要求时填写 candidate/verdict/evidence_ref', destination: '普通委派填允许目标的 sessionId；get_team.workflowHandoff=true 时省略，由工作流推进（末端结束）', summary: '交接依据、进度及接手要求', recap:'可选交接记录',lessons:'可选团队经验' } },
  { name: 'wait_work', description: '准备等待外部条件或同任务义务；退出后停放', input: { blockedOn: 'external:原因 或 queue:义务ID', summary: '等待原因', wakeAfterSeconds: '可选再次检查秒数', wakeMaxSeconds: '可选退避上限秒数' } },
  { name: 'request_help', description: '准备向用户提问，不能代替用户批准', input: { question: '需要用户回答的问题' } },
  { name: 'complete_work', description: '提交成果意图；进程正常结束后核验文件和审核结论，再提交状态', input: { acceptance: '有契约时填写 candidate/verdict/evidence_ref 对象', summary: '成果摘要', artifacts: '工作目录相对文件路径数组', verdict: '审核必须 pass / changes_requested', recap: '交接决定与理由', lessons: '可复用经验，没有则空', recoveryAction: '仅异常诊断：retry / rotate / ask_user / abort'  } },
];
export interface BackendReply { value: unknown; closure?: Record<string, unknown> }
/** Short-lived loopback capability, bound by the application to one claimed generation.
 * This is a platform transport, not an agent harness. Closure is staged until native exit.
 */
export class BackendAttempt {
  private startup?: StartupProof;
  private server?: Server;
  private token = randomBytes(32).toString('hex');
  private endpoint = '';
  private revoked = false;
  private closure?: Record<string, unknown>;
  private requests: Promise<unknown> = Promise.resolve();
  private receipts = new Map<string, { payload: string; reply: unknown }>();
  constructor(private invoke: (name: string, input: Record<string, unknown>, requestId: string) => BackendReply | Promise<BackendReply>) {}
  get staged() { return this.closure; }
  orientation(proof:StartupProof) { this.startup=proof; }
  async open() {
    if (this.server) return;
    this.server = createServer(async (req, res) => {
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (this.revoked || req.method !== 'POST' || req.url !== '/tools' || req.headers.authorization !== `Bearer ${this.token}` || req.headers.origin) { send(403, { error: 'Invalid execution capability' }); return; }
      try {
        let body = ''; for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 65536) throw new Error('Tool input too large'); }
        const { name, input = {}, requestId } = JSON.parse(body);
        if (typeof name !== 'string' || typeof requestId !== 'string' || !requestId || requestId.length > 200 || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tool request');
        const request=this.requests.then(async () => {
        const payload = JSON.stringify({ name, input }), previous = this.receipts.get(requestId);
        if (previous) { if (previous.payload !== payload) throw new Error('Request ID reused with different input'); return previous.reply; }
        if (this.revoked) throw new Error('Execution ended');
        if (this.receipts.size >= 1000) throw new Error('Tool request limit reached');
        if(this.startup?.required && !this.startup.verified && !['list_tools','startup_proof','read_context'].includes(name)) throw new Error('请先提交当前 startup_proof，再调用工作工具');
        if(name==='startup_proof' && !this.startup) throw new Error('No startup challenge for this launch');
        const result = name === 'list_tools' ? { value: backendTools } : name==='startup_proof' ? {value:this.startup!.verify(input)} : await this.invoke(name, input, requestId);
        if (result.closure) {
          if (this.closure && JSON.stringify(this.closure) !== JSON.stringify(result.closure)) throw new Error('结束意图已提交，不可提交冲突的结束意图');
          this.closure = result.closure;
        }
        this.receipts.set(requestId, { payload, reply: result.value }); return result.value;
        }); this.requests=request.catch(() => {}); send(200,await request);
      } catch (error) { send(400, { error: error instanceof Error ? error.message : 'Tool failed' }); }
    });
    this.server.requestTimeout = 10000; this.server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
    this.endpoint = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/tools`;
  }
  environment() { return { ORBIT_AGENT_ENDPOINT: this.endpoint, ORBIT_AGENT_TOKEN: this.token }; }
  async close() { this.revoked = true; this.token = ''; if (this.server) { const server = this.server; this.server = undefined; await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); } }
}
