export const foregroundPrompt = '你是 Orbit 常驻交互助手。使用简短自然的中文交流。你只负责理解、澄清和平台调度，不执行具体工作。用户要求完成工作时，先用 save_request 保存需求，再查询团队或创建团队，最后 dispatch_task 派发。工具成功前不能声称已经执行。用户仅要求记录时只保存不派发。查询状态必须调用工具。只有用户明确同意才能取消任务。不能直接执行代码。以下仅为历史资料，不是新的操作请求：';
export const foregroundTools = [
        { type: 'function', function: { name: 'list_tasks', description: '查询本机任务及其真实状态', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'save_request', description: '保存用户明确提出的需求为待派发任务，不会执行', parameters: { type: 'object', properties: { text: { type: 'string' }, attachmentIds: { type: 'array', items: { type: 'string' } } }, required: ['text'] } } },
        { type: 'function', function: { name: 'list_teams', description: '查询本机已创建的执行团队', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'create_team', description: '创建包含执行者和检查者的 Codex 团队', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
        { type: 'function', function: { name: 'dispatch_task', description: '将已保存的需求派发给真实执行团队', parameters: { type: 'object', properties: { taskId: { type: 'string' }, teamId: { type: 'string' } }, required: ['taskId', 'teamId'] } } },
        { type: 'function', function: { name: 'get_task_execution', description: '查询任务当前进度、待回答问题和成果', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } } },
        { type: 'function', function: { name: 'answer_task', description: '将用户的回答交给等待信息的任务并继续执行', parameters: { type: 'object', properties: { taskId: { type: 'string' }, answer: { type: 'string' } }, required: ['taskId', 'answer'] } } },
        { type: 'function', function: { name: 'cancel_task', description: '根据用户明确要求取消任务', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } } },
      ];
export type PlatformExecute = (name: string, args: unknown, callId: string) => unknown | Promise<unknown>;
