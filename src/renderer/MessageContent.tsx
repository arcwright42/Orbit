import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Render text formatting only: no raw HTML, embeds or automatic remote image requests.
export const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  return <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <span title={href}>{children}{href && <span className="message-url"> ({href})</span>}</span>,
    img: ({ alt }) => <span className="message-image-label">{alt ? `[图片：${alt}]` : '[图片]'}</span>,
    table: ({ children }) => <div className="message-table"><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
});
