import type { Attachment, Conversation } from '../../contracts';
import type { HistoryContext } from './history';

// Orbit's port: application code does not depend on Pi classes or provider protocols.
export interface AgentInput {
  requestId: string;
  text: string;
  attachments: Attachment[];
  roomId?: string;
  turnId?: string;
  generation?: number;
  history?: HistoryContext;
}

export interface BusinessTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  roomId?: string;
  turnId?: string;
  generation?: number;
  sessionId: string;
  requestId: string;
  attachmentIds: string[];
  currentAttachmentIds: string[];
}

export type ExecuteTool = (name: string, args: unknown, context: ToolContext) => unknown | Promise<unknown>;

export interface AgentRuntime {
  read(): Promise<Conversation>;
  send(input: AgentInput): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
