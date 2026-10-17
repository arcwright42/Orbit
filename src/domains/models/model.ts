export type ModelSource = 'api' | 'codex-local';
export type ModelProtocol = 'openai-responses' | 'anthropic-messages' | 'openai-completions' | 'openai-codex-responses';

export interface ProviderDefinition {
  id: string;
  name: string;
  source: ModelSource;
  protocol: ModelProtocol;
  customEndpoint: boolean;
  manualModel: boolean;
}

export interface ModelProfile {
  id: string;
  name: string;
  source: ModelSource;
  providerId: string;
  modelId: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelProfileView extends ModelProfile {
  hasApiKey: boolean;
  readOnly?: boolean;
}

export interface ModelProfileInput extends Omit<ModelProfile, 'id'> {
  id?: string;
  // Write-only. Omission preserves an existing key; it is never returned to the UI.
  apiKey?: string;
}

export interface ModelConfigurationState {
  providers: ProviderDefinition[];
  profiles: ModelProfileView[];
  activeProfileId: string | null;
  error?: string;
}

export interface ModelOption { id: string; name: string; contextWindow: number; maxTokens: number }
export interface CodexLoginStatus {
  status: 'available' | 'missing' | 'expired' | 'invalid' | 'api-key';
  message: string;
  expiresAt?: number;
}
export interface ModelConnectionResult { ok: boolean; message: string }

export interface ModelsApi {
  read(): Promise<ModelConfigurationState>;
  catalog(providerId: string): Promise<ModelOption[]>;
  save(input: ModelProfileInput): Promise<ModelConfigurationState>;
  remove(id: string): Promise<ModelConfigurationState>;
  activate(id: string): Promise<ModelConfigurationState>;
  detectCodex(): Promise<CodexLoginStatus>;
  test(id: string): Promise<ModelConnectionResult>;
  onChanged(listener: (state: ModelConfigurationState) => void): () => void;
}

// Internal ports. None of these storage or credential objects crosses renderer IPC.
export interface StoredModelProfile { profile: ModelProfile; encryptedApiKey?: string }
export interface ModelDocument { version: 1; activeProfileId: string | null; profiles: StoredModelProfile[] }
export interface ModelRepository { read(): ModelDocument | undefined; write(document: ModelDocument): void }
export interface SecretProtection { encrypt(value: string): string; decrypt(value: string): string }
export interface ModelCredential { apiKey: string; expiresAt?: number }
export interface CodexCredentialSource { status(): CodexLoginStatus; resolve(): ModelCredential }
export interface ModelRuntimePort {
  isBusy(): boolean;
  configure(profile: ModelProfile | null): Promise<void>;
  catalog(providerId: string): Promise<ModelOption[]>;
  testModel(profile: ModelProfile): Promise<ModelConnectionResult>;
}
export class ModelConfigurationError extends Error {}
