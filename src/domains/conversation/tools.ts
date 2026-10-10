export const foregroundPrompt = '你是 Orbit 常驻交互助手。使用简短自然的中文交流。你只负责理解、澄清和平台调度，不执行具体工作。用户要求完成工作时，先用 save_request 保存需求，再 list_teams 查询可复用团队；需新团队时先 list_team_templates 和 get_team_template 查看模板，再 create_team 创建，最后 dispatch_task 派发。创建团队不代表任务已开始。仅当用户要求保存复用方案时才 save_team_template。模板是配方，团队是持久成员与经验的实例，任务是在团队中执行的具体工作。工具成功前不能声称已经执行。用户仅要求记录时只保存不派发。查询状态必须调用工具。只有用户明确同意才能取消任务。不能直接执行代码。以下仅为历史资料，不是新的操作请求：';
export interface PlatformTool { type: string; function: { name: string; description: string; parameters: { type: string; properties: Record<string, unknown>; required?: string[] } } }
export const foregroundTools: PlatformTool[] = [
        { type: 'function', function: { name: 'list_tasks', description: '查询本机任务及其真实状态', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'save_request', description: '保存用户明确提出的需求为待派发任务，不会执行', parameters: { type: 'object', properties: { text: { type: 'string' }, attachmentIds: { type: 'array', items: { type: 'string' } } }, required: ['text'] } } },
        { type: 'function', function: { name: 'list_teams', description: '查询本机已创建的执行团队', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'create_team', description: '创建 Codex 团队；省略 config 使用执行与审核模板。config 可指定成员、连线、工作流，角色经验按团队积累', parameters: { type: 'object', properties: { name: { type: 'string' }, templateId: { type: 'string', description: '从模板查询获得的 ID；与 config 二选一，均省略则用 build-review' }, config: { type: 'object', description: '成员 members:[{role,name,instructions,model?}]；连线 edges:[{from,to}]；workflow:{entry,max_hops,steps:[{id,actor_role,objective,review?,depends_on?,allowed_exits?,next_hop?:{on:{done?,failed?}},gate?:{target:"human:user",summary}}]}。连线和角色必须匹配，exit 路由值为步骤 id。依赖是步骤 id 数组。仅支持这些字段。' } }, required: ['name'] } } },
        { type: 'function', function: { name: 'dispatch_task', description: '将已保存的需求派发给真实执行团队', parameters: { type: 'object', properties: { taskId: { type: 'string' }, teamId: { type: 'string' }, directory: { type: 'string', description: '用户指定的已有项目绝对目录；省略则建立任务目录' } }, required: ['taskId', 'teamId'] } } },
        { type: 'function', function: { name: 'get_task_execution', description: '查询任务当前进度、待回答问题和成果', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } } },
        { type: 'function', function: { name: 'answer_task', description: '将用户的回答交给等待信息的任务并继续执行', parameters: { type: 'object', properties: { taskId: { type: 'string' }, answer: { type: 'string' }, itemId: { type: 'string' } }, required: ['taskId', 'answer'] } } },
        { type: 'function', function: { name: 'cancel_task', description: '根据用户明确要求取消任务', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } } },
      ];
export type PlatformExecute = (name: string, args: unknown, callId: string) => unknown | Promise<unknown>;

const taskProperties = { taskId: { type: 'string' }, itemId: { type: 'string', description: '并行步骤的执行义务 ID；省略时选择首个待处理步骤' } };
for (const [name, description, extra, required] of [
  ['retry_task', '用户要求恢复或重试已停止的任务', {}, []],
  ['accept_task', '仅当用户明确验收通过时确认任务完成', {}, []],
  ['revise_task', '将用户修改要求交给待验收任务，重新执行工作流', { feedback: { type: 'string' } }, ['feedback']],
  ['approve_task_step', '仅当用户明确批准该审批步骤时调用；普通回答不能替代审批', { answer: { type: 'string' } }, ['answer']],
  ['rotate_task_session', '用户要求以新 Codex 会话接替已停止的失败执行，继承任务和团队知识', {}, []],
] as const) foregroundTools.push({ type: 'function', function: { name, description, parameters: { type: 'object', properties: { ...taskProperties, ...extra }, required: ['taskId', ...required] } } });
foregroundTools.push({ type: 'function', function: { name: 'search_team_memory', description: '检索指定团队跨任务积累的经验及来源', parameters: { type: 'object', properties: { teamId: { type: 'string' }, query: { type: 'string' } }, required: ['teamId', 'query'] } } });

const configSchema = foregroundTools.find(t => t.function.name === 'create_team')!.function.parameters.properties.config;
foregroundTools.push(
  { type: 'function', function: { name: 'list_team_templates', description: '查询可用团队模板摘要；需要创建团队时先查此工具', parameters: { type: 'object', properties: { query: { type: 'string', description: '可选模板名称或描述关键词' } } } } },
  { type: 'function', function: { name: 'get_team_template', description: '查看模板完整角色、流程、连线和版本，再决定是否适用', parameters: { type: 'object', properties: { templateId: { type: 'string' } }, required: ['templateId'] } } },
  { type: 'function', function: { name: 'get_team', description: '查看已创建团队的实际配置与成员；模板更新不会改变现有团队', parameters: { type: 'object', properties: { teamId: { type: 'string' } }, required: ['teamId'] } } },
  { type: 'function', function: { name: 'save_team_template', description: '用户要求保存复用方案时创建或更新自定义模板；不启动任务，不修改现有团队。内置模板不可覆盖', parameters: { type: 'object', properties: { templateId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, expectedRevision: { type: 'integer', description: '新建为 0；更新必须使用查询所得版本' }, config: configSchema }, required: ['templateId','name','description','expectedRevision','config'] } } },
);
