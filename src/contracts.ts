// Serializable application DTOs. Renderer never imports persistence or runtime code.
export interface Attachment {
  id: string;
  name: string;
  size: number;
  createdAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'system';
  text: string;
  taskId: string;
  createdAt: string;
}

export interface Task {
  id: string;
  requestId: string;
  title: string;
  brief: string;
  status: 'pending' | 'canceled';
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
