import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextPolicy, estimateTokens, historyContext } from '../src/domains/conversation/context-budget';
import type { Message } from '../src/contracts';

test('voice history injection stays within its estimated budget without modifying raw records', () => {
  const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), role: i % 2 ? 'assistant' : 'user', channel: 'voice', text: '中文历史'.repeat(200),
    createdAt: new Date(i * 1000).toISOString(),
  }));
  const context = historyContext(messages, contextPolicy.voiceHistoryTokens);
  assert.ok(estimateTokens(JSON.parse(context)) <= contextPolicy.voiceHistoryTokens);
  assert.equal(JSON.parse(context).at(-1).id, '99');
  assert.ok(JSON.parse(context).length < 100);
  assert.equal(messages.length, 100);
  assert.equal(messages[0].text.length, 800);
});
