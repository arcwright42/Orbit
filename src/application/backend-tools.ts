import { BackendAttempt, type BackendReply } from '../domains/runtime/backend-tools';
import type { ExecutionQueue } from '../domains/orchestration/queue';
import type { QueueItem, KnowledgeCheckpoint } from '../domains/orchestration/types';
import type { TeamRegistry, Seat } from '../domains/teams/registry';
import type { MemoryStore } from '../domains/memory/store';

function text(value: unknown, max = 16000): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid tool text'); return value; }
export function backendAttempt(queue: ExecutionQueue, teams: TeamRegistry, memory: MemoryStore, seat: Seat, attempt: QueueItem, targets: () => Seat[], context?: () => Promise<string>, workflowHandoff: () => boolean = () => false, checkpoint?: (knowledge: KnowledgeCheckpoint,requestId: string) => unknown): BackendAttempt {
  return new BackendAttempt(async (name, input,requestId): Promise<BackendReply> => {
    const live = queue.get(attempt.id);
    if (live.generation !== attempt.generation || live.destination !== seat.sessionId || live.state !== 'in-progress' || live.cancelRequested) throw new Error('执行义务已结束、取消或换代');
    const scope = { kind: 'team' as const, id: seat.teamId };
    const ownItem = (id: unknown) => { const item = queue.get(text(id, 256)); if (item.taskId !== attempt.taskId) throw new Error('不能读取其他任务'); return item; };
    if (input.acceptance != null && (typeof input.acceptance !== 'object' || ['candidate','verdict','evidence_ref'].some(k => typeof (input.acceptance as Record<string,unknown>)[k] !== 'string'))) throw new Error('Invalid acceptance receipt');
    const base = { acceptance:null, outcome: '', summary: '', question: '', artifacts: [], destination: '', blockedOn: '', wakeAfterSeconds: 0, wakeMaxSeconds: 0, verdict: '', recap: '', lessons: '', recoveryAction: '' };
    const stage = (closure: Record<string, unknown>): BackendReply => {
      for(const key of ['recap','lessons']) if(input[key]!==undefined && (typeof input[key]!=='string' || input[key].length>16000)) throw new Error('Invalid authored knowledge');
      return { value: { prepared: true, committed: false, instruction: '请结束当前执行；平台在原生进程退出并核验后提交。' }, closure: { ...base, recap:input.recap ?? '',lessons:input.lessons ?? '',...closure } };
    };
    switch (name) {
      case 'read_context': { if(!context) throw new Error('Context provider unavailable'); return {value:await context()}; }
      case 'write_recap': { if(!checkpoint) throw new Error('Checkpoint provider unavailable'); const recap=text(input.recap); if(input.lessons!==undefined && (typeof input.lessons!=='string' || input.lessons.length>16000)) throw new Error('Invalid authored knowledge'); return {value:checkpoint({recap,lessons:input.lessons as string | undefined},requestId)}; }
      case 'list_work': {
        const after = input.after ?? 0, limit = input.limit ?? 20;
        if (!Number.isInteger(after) || Number(after) < 0 || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error('Invalid pagination');
        return { value: queue.list().filter(i => i.taskId === attempt.taskId).slice(Number(after), Number(after) + Number(limit)).map(({id,state,source,destination,blockedOn,resolution}) => ({id,state,source,destination,blockedOn,resolution})) };
      }
      case 'get_work': { const item=ownItem(input.itemId ?? attempt.id); return { value: {...item,events:queue.recentEvents(item.id)} }; }
      case 'get_team': return { value: { id: seat.teamId, name: teams.require(seat.teamId).name, current: { role: seat.role, sessionId: seat.sessionId }, workflowHandoff:workflowHandoff(), handoffTargets: targets().map(s => ({role:s.role,sessionId:s.sessionId})) } };
      case 'search_team_memory': return { value: memory.search([scope], text(input.query)) };
      case 'read_team_memory': { const record = memory.list(scope).find(m => m.id === input.memoryId && m.enabled); if (!record) throw new Error('团队经验不存在'); return { value: record }; }
      case 'report_progress': queue.activity(attempt.id, attempt.generation!, text(input.note, 2000)); return { value: { recorded: true } };
      case 'handoff_work': {
        const destination = input.destination==null || input.destination==='' ? '' : text(input.destination, 256);
        if(destination ? !targets().some(s=>s.sessionId===destination) : !workflowHandoff()) throw new Error('交接目标不允许');
        return stage({outcome:'handoff', acceptance:input.acceptance ?? null, destination, summary:text(input.summary)});
      }
      case 'wait_work': {
        const blockedOn = text(input.blockedOn, 256); if (!/^(external|queue):.+/.test(blockedOn)) throw new Error('Invalid blocker');
        if (blockedOn.startsWith('queue:')) { const item = ownItem(blockedOn.slice(6)); if (item.id === attempt.id) throw new Error('不能等待自身'); }
        const delay = input.wakeAfterSeconds ?? 0, max = input.wakeMaxSeconds ?? delay;
        if (!Number.isInteger(delay) || Number(delay) < 0 || Number(delay) > 86400 || !Number.isInteger(max) || Number(max) < Number(delay) || Number(max) > 604800) throw new Error('Invalid wake timing');
        return stage({outcome:'waiting',blockedOn,summary:text(input.summary),wakeAfterSeconds:delay,wakeMaxSeconds:max});
      }
      case 'request_help': return stage({outcome:'question',question:text(input.question)});
      case 'complete_work': {
        if (!Array.isArray(input.artifacts ?? []) || (input.artifacts as unknown[] | undefined)?.some(p => typeof p !== 'string')) throw new Error('Invalid artifacts');
        if (input.verdict !== undefined && !['','pass','changes_requested'].includes(String(input.verdict))) throw new Error('Invalid verdict');
        if (input.recoveryAction !== undefined && !['','retry','rotate','ask_user','abort'].includes(String(input.recoveryAction))) throw new Error('Invalid recovery action');
        for (const key of ['recap','lessons']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 16000)) throw new Error('Invalid knowledge');
        return stage({outcome:'completed',acceptance:input.acceptance ?? null,summary:text(input.summary),artifacts:input.artifacts ?? [],verdict:input.verdict ?? '',recap:input.recap ?? '',lessons:input.lessons ?? '',recoveryAction:input.recoveryAction ?? ''});
      }
      default: throw new Error('Unsupported backend tool');
    }
  });
}
