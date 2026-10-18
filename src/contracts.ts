// Serializable application DTOs. Renderer never imports persistence or runtime code.
import type { ModelsApi } from './domains/models/model';
import type { TaskExecution, TaskStatus } from './domains/tasks/execution';
export interface Attachment {
  id: string;
  name: string;
  size: number;
  createdAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'system' | 'assistant';
  text: string;
  taskId?: string;
  attachmentIds?: string[];
  requestId?: string;
  createdAt: string;
  roomId?: string;
  sessionId?: string;
  turnId?: string;
  seq?: number;
  channel?: 'text' | 'voice' | 'system';
  status?: 'complete' | 'interrupted' | 'failed';
}

export interface Task {
  id: string;
  requestId: string;
  title: string;
  brief: string;
  status: TaskStatus;
  execution?: TaskExecution;
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
}

export interface Conversation {
  roomId?: string;
  activeChannel?: 'text' | 'voice';
  nextCursor?: number;
  summary?: { text: string; throughEntryId: string };
  sessionId?: string;
  model?: string;
  configured: boolean;
  status: 'idle' | 'running';
  messages: Message[];
  draft: string;
  error?: string;
}

export interface OrbitApi {
  models: ModelsApi;
  room: {
    read(page?: { before?: number; limit?: number }): Promise<Conversation>;
    onChanged(listener: (state: Conversation) => void): () => void;
  };
  conversation(): Promise<Conversation>;
  sendMessage(input: SubmitRequest): Promise<void>;
  stopReply(): Promise<void>;
  onConversation(listener: (state: Conversation) => void): () => void;
  voiceStart(wake: boolean): Promise<void>;
  voiceStop(): Promise<void>;
  voiceAudio(data: Uint8Array): Promise<void>;
  onVoice(listener: (event: VoiceEvent) => void): () => void;
  workspace(): Promise<Workspace>;
  submit(input: SubmitRequest): Promise<Workspace>;
  cancelTask(id: string): Promise<Workspace>;
  pickAttachments(): Promise<Attachment[]>;
  openAttachment(id: string): Promise<void>;
}

export type VoiceEvent =
  | { type: 'state'; state: 'off' | 'waiting' | 'connecting' | 'listening' | 'paused' }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; id?: string; turnId?: string; status?: 'complete' | 'interrupted' | 'failed' }
  | { type: 'audio'; data: string }
  | { type: 'interrupt' }
  | { type: 'error'; text: string };
