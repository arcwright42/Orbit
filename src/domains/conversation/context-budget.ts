import type { Message } from '../../contracts';

export const contextPolicy = {
  textWindowTokens: 256 * 1024,
  textReserveTokens: 16 * 1024,
  textKeepRecentTokens: 20000,
  textMaxOutputTokens: 4096,
  voiceHistoryTokens: 16 * 1024,
  voiceHistoryTurns: 8,
} as const;

// Provider-neutral estimate, not an exact tokenizer count (especially not audio tokens).
export const estimateTokens = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') / 2);

export function historyContext(messages: Message[], budget: number): string {
  const selected: object[] = [];
  let remaining = Math.max(0, budget - 2);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'system') continue;
    const record = { id: message.id, role: message.role, channel: message.channel, at: message.createdAt, text: message.text };
    const cost = estimateTokens(record) + 1;
    if (cost > remaining) break;
    selected.unshift(record); remaining -= cost;
  }
  return JSON.stringify(selected);
}
