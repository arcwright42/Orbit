import type { Conversation } from '../../contracts';
import type { AgentInput, BusinessTool, ToolContext } from '../../domains/conversation/agent';
import type { ModelConnectionResult, ModelCredential, ModelOption, ModelProfile } from '../../domains/models/model';

export interface AgentSetup {
  directory: string;
  systemPrompt: string;
  tools: BusinessTool[];
  model?: ModelProfile | null;
}

export type AgentCommand =
  | { id: string; type: 'init'; setup: AgentSetup }
  | { id: string; type: 'read' | 'abort' | 'close' }
  | { id: string; type: 'send'; input: AgentInput }
  | { id: string; type: 'configure' | 'test_model'; model: ModelProfile | null }
  | { id: string; type: 'catalog'; providerId: string };

export type ParentMessage = AgentCommand
  | { type: 'tool_result'; id: string; result?: unknown; error?: string }
  | { type: 'credential_result'; id: string; credential?: ModelCredential; error?: string };
export interface AgentResponse {
  type: 'response'; id: string; state?: Conversation; error?: string; configurationError?: boolean;
  models?: ModelOption[]; connection?: ModelConnectionResult;
}
export type WorkerMessage =
  | AgentResponse
  | { type: 'state'; state: Conversation }
  | { type: 'credential'; id: string; profileId: string }
  | { type: 'tool'; id: string; name: string; args: unknown; context: ToolContext };

export interface AgentProcess {
  send(message: ParentMessage): void;
  onMessage(listener: (message: WorkerMessage) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}
