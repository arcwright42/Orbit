import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../src/renderer/MessageContent';

test('assistant Markdown renders structured answers without executing HTML or loading remote content', () => {
  const html = renderToStaticMarkup(createElement(MessageContent, { text: [
    '## 发布计划', '', '1. **检查**页面', '2. 运行 `npm run build`', '',
    '| 步骤 | 状态 |', '| --- | --- |', '| 验证 | 待开始 |', '',
    '```js', 'console.log("ready")', '```', '',
    '<script>alert(1)</script>', '', '[危险链接](javascript:alert%281%29)', '',
    '![预览](https://example.com/private-tracker.png)', '', '<img src=x onerror="alert(1)">',
  ].join('\n') }));
  assert.match(html, /<ol>/); assert.match(html, /<strong>检查<\/strong>/);
  assert.match(html, /<table>/); assert.match(html, /<pre><code/);
  assert.doesNotMatch(html, /<script|<img|onerror=|href=/);
  assert.match(html, /\[图片：预览\]/);
});
