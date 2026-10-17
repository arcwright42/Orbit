import type { Conversation } from '../../contracts';
import type { AgentInput, BusinessTool, ToolContext } from '../../domains/conversation/agent';

export interface AgentSetup {
  directory: string;
  systemPrompt: string;
  tools: BusinessTool[];
}

export type AgentCommand =
  | { id: string; type: 'init'; setup: AgentSetup }
  | { id: string; type: 'read' | 'abort' | 'close' }
  | { id: string; type: 'send'; input: AgentInput };

export type ParentMessage = AgentCommand | { type: 'tool_result'; id: string; result?: unknown; error?: string };
export type WorkerMessage =
  | { type: 'response'; id: string; state?: Conversation; error?: string }
  | { type: 'state'; state: Conversation }
  | { type: 'tool'; id: string; name: string; args: unknown; context: ToolContext };

export interface AgentProcess {
  send(message: ParentMessage): void;
  onMessage(listener: (message: WorkerMessage) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}
