import { createHash } from 'node:crypto';
import type { WorkspaceService } from './workspace';
import type { TaskExecutionService } from './task-execution';
import type { PlatformExecute } from '../domains/conversation/tools';

function string(value: unknown) { if (typeof value !== 'string' || value.length > 16000) throw new Error('Invalid tool argument'); return value; }
/** Shared application boundary for Pi and Qwen. Neither harness owns business orchestration. */
export function platformTools(workspace: WorkspaceService, execution: TaskExecutionService, changed: () => void): PlatformExecute {
  const invoke:PlatformExecute = async (name, args, callId) => {
    const input = (args ?? {}) as Record<string, unknown>; if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tool arguments');
    const itemId = input.itemId === undefined ? undefined : string(input.itemId);
    switch (name) {
      case 'search_history': return workspace.history.search(input);
      case 'read_history': return workspace.history.read(input);
      case 'list_tasks': return workspace.snapshot().tasks.map(({ id, title, status }) => ({ id, title, status }));
      case 'save_request': {
        const requestId = createHash('sha256').update(callId).digest('hex');
        const snapshot = workspace.submit({ requestId, text: string(input.text), attachmentIds: input.attachmentIds ?? [] }); changed();
        return { task: snapshot.tasks.find(t => t.requestId === requestId), executed: false };
      }
      case 'list_team_templates': return execution.templates.list(input.query === undefined ? '' : string(input.query));
      case 'get_team_template': return execution.templates.get(string(input.templateId));
      case 'save_team_template': return execution.templates.save({ id: string(input.templateId), name: string(input.name), description: string(input.description), config: input.config, expectedRevision: input.expectedRevision as number });
      case 'list_teams': return execution.teams.list().map(t => ({ id: t.id, name: t.name, roles: t.seats.map(s => ({ role: s.role, name: s.name })), runtime: 'codex' }));
      case 'get_team': return execution.teamContext(string(input.teamId));
      case 'configure_team_context': return execution.configureContext(string(input.teamId),string(input.role),input.profiles as import('../domains/teams/registry').Seat['context_profiles'],input.contextAtoms as import('../domains/teams/registry').Seat['context_atoms']);
      case 'create_team': return execution.createTeam(string(input.name), input.config, input.templateId === undefined ? undefined : string(input.templateId), callId);
      case 'dispatch_task': await execution.dispatch(string(input.taskId), string(input.teamId), input.directory === undefined ? undefined : string(input.directory)); break;
      case 'get_task_execution': break;
      case 'answer_task': execution.answer(string(input.taskId), string(input.answer), itemId); break;
      case 'retry_task': execution.retry(string(input.taskId), itemId); break;
      case 'revise_task': await execution.revise(string(input.taskId), string(input.feedback)); break;
      case 'approve_task_step': execution.approve(string(input.taskId), string(input.answer), itemId); break;
      case 'rotate_task_session': await execution.rotateSession(string(input.taskId), itemId); break;
      case 'accept_task': execution.accept(string(input.taskId)); return workspace.snapshot().tasks.find(t => t.id === input.taskId);
      case 'cancel_task': await execution.cancel(string(input.taskId)); return workspace.snapshot().tasks.find(t => t.id === input.taskId);
      case 'search_team_memory': { const team = execution.teams.require(string(input.teamId)); return execution.memory.search([{ kind: 'team', id: team.id }], string(input.query)); }
      default: throw new Error('Unsupported tool');
    }
    return execution.detail(string(input.taskId));
  };
  return async (name,args,callId) => {
    let result;
    try { result=await invoke(name,args,callId); }
    catch(error) {workspace.history.recordTool(callId,name,args,{error:error instanceof Error ? error.message : 'Tool failed'});throw error;}
    workspace.history.recordTool(callId,name,args,result);return result;
  };
}
