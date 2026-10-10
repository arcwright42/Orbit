// Serializable application DTOs. Renderer never imports persistence or runtime code.
export interface Attachment {
  id: string;
  name: string;
  size: number;
  createdAt: string;
}

export interface Message {
  channel?: 'text' | 'voice' | 'platform';
  id: string;
  role: 'user' | 'system' | 'assistant';
  text: string;
  taskId?: string;
  createdAt: string;
}

export interface Task {
  id: string;
  requestId: string;
  title: string;
  brief: string;
  status: 'pending' | 'running' | 'blocked' | 'review' | 'completed' | 'failed' | 'canceled';
  teamId?: string;
  executionSummary?: string;
  attachmentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SubmitRequest {
  requestId: string;
  text: string;
  attachmentIds: string[];
}

export interface Workspace {
  messages: Message[];
  tasks: Task[];
  attachments: Attachment[];
  settings: { openrigUrl: string };
}

export interface Team {
  id: string;
  name: string;
  lifecycle: string;
}

export type ConnectionResult =
  | { state: 'connected'; checkedAt: string; teams: Team[] }
  | { state: 'unavailable'; checkedAt: string; reason: string };

export interface OrbitApi {
  textModel(): Promise<TextModelSettings>;
  saveTextModel(input: TextModelInput): Promise<TextModelSettings>;
  stopText(): Promise<void>;
  onChat(listener: (event: ChatEvent) => void): () => void;
  chatText(text: string, attachmentIds: string[]): Promise<void>;
  teamTemplates(): Promise<{ id: string; name: string; description: string; revision: number }[]>;
  localTeams(): Promise<LocalTeamInfo[]>;
  createTeam(name: string, config?: unknown, templateId?: string): Promise<LocalTeamInfo>;
  dispatchTask(taskId: string, teamId: string, directory?: string): Promise<Workspace>;
  pickWorkspaceDirectory(): Promise<string | undefined>;
  approveTaskStep(taskId: string, answer: string, itemId?: string): Promise<Workspace>;
  rotateTaskSession(taskId: string, itemId?: string): Promise<Workspace>;
  execution(taskId: string): Promise<TaskExecution | null>;
  answerTask(taskId: string, answer: string): Promise<Workspace>;
  reconcileTask(taskId: string): Promise<Workspace>;
  retryTask(taskId: string): Promise<Workspace>;
  acceptTask(taskId: string): Promise<Workspace>;
  reviseTask(taskId: string, feedback: string): Promise<Workspace>;
  openResult(taskId: string, index: number): Promise<void>;
  importContextPack(teamId: string): Promise<void>;
  onWorkspace(listener: () => void): () => void;
  voiceStart(wake: boolean): Promise<void>;
  voiceStop(): Promise<void>;
  voiceAudio(data: Uint8Array): Promise<void>;
  onVoice(listener: (event: VoiceEvent) => void): () => void;
  workspace(): Promise<Workspace>;
  submit(input: SubmitRequest): Promise<Workspace>;
  cancelTask(id: string): Promise<Workspace>;
  pickAttachments(): Promise<Attachment[]>;
  openAttachment(id: string): Promise<void>;
  saveConnection(url: string): Promise<Workspace>;
  checkConnection(): Promise<ConnectionResult>;
}

export type VoiceEvent =
  | { type: 'state'; state: 'off' | 'waiting' | 'connecting' | 'listening' }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'audio'; data: string }
  | { type: 'interrupt' }
  | { type: 'error'; text: string };

export interface LocalTeamInfo { id: string; name: string; workspace: string; contextPack?: string; seats: { name: string; role: string; sessionId: string; nativeId: string | null }[] }
export interface TaskExecution {
  teamId: string; phase: string; workspace?: string; steps?: { id: string; itemId: string; role: string; state: string; blockedOn?: string }[]; question?: string; summary?: string; artifacts: string[];
  state: string; blockedOn?: string; pickup: string; events: { seq: number; state: string; note: string; at: string }[];
}

export type TextModelProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export interface TextModelInput {
  protocol: TextModelProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearKey?: boolean;
}
export interface TextModelSettings { protocol: TextModelProtocol; baseUrl: string; model: string; hasKey: boolean }
export type ChatEvent = { type: 'compaction'; active: boolean } | { type: 'state'; busy: boolean } | { type: 'delta'; text: string } | { type: 'error'; text: string };
