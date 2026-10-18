import { useEffect, useRef, useState } from 'react';
import type { Conversation, Message } from '../contracts';

function merge(previous: Message[], incoming: Message[]) {
  const messages = new Map(previous.map(message => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** Live events are a recent page, not the whole archive. Keep explicitly loaded older pages. */
export function useRoom(onIdle: () => void, onError: (error: unknown) => void) {
  const [conversation, setConversation] = useState<Conversation>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const callbacks = useRef({ onIdle, onError }); callbacks.current = { onIdle, onError };
  const loading = useRef(false);
  useEffect(() => {
    let live = false, disposed = false;
    const accept = (state: Conversation) => {
      if (disposed) return;
      setConversation(previous => {
        if (!previous || previous.roomId !== state.roomId) return state;
        const keepCursor = (previous.messages[0]?.seq ?? Infinity) < (state.messages[0]?.seq ?? Infinity);
        return { ...state, messages: merge(previous.messages, state.messages), nextCursor: keepCursor ? previous.nextCursor : state.nextCursor };
      });
      if (state.status === 'idle') callbacks.current.onIdle();
    };
    const unsubscribe = window.orbit.room.onChanged(state => { live = true; accept(state); });
    void window.orbit.room.read().then(state => { if (!live) accept(state); }).catch(error => { if (!disposed) callbacks.current.onError(error); });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  async function loadOlder() {
    if (loading.current || !conversation?.nextCursor) return false;
    loading.current = true; setLoadingOlder(true);
    const roomId = conversation.roomId;
    try {
      const page = await window.orbit.room.read({ before: conversation.nextCursor });
      setConversation(previous => !previous || previous.roomId !== roomId ? previous : {
        ...previous, messages: merge(page.messages, previous.messages), nextCursor: page.nextCursor,
      });
      return true;
    } catch (error) { callbacks.current.onError(error); return false; }
    finally { loading.current = false; setLoadingOlder(false); }
  }
  return { conversation, loadingOlder, loadOlder };
}
