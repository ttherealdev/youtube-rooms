import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage } from '@youtube-room/protocol';
import { Pin, Send, SmilePlus } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/field';
import { cn, formatClock, nonce } from '~/lib/utils';
import type { RoomSocket } from '~/realtime/socket';
import { useMessages, useRoomStore, useSelf } from '~/stores/room-store';

const REACTIONS = ['❤️', '😂', '🔥', '😮', '👏', '💀', '🎉', '👀'] as const;

export function ChatPanel({ socket }: { socket: RoomSocket | null }) {
  const messages = useMessages();
  const self = useSelf();
  const typing = useRoomStore((state) => state.typing);
  const participants = useRoomStore((state) => state.participants);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  /**
   * Virtualised: a long-running room accumulates hundreds of messages and
   * rendering them all makes every new message janky.
   */
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });

  // Autoscroll, but only when the reader is already at the bottom. Yanking
  // someone back down while they are reading history is infuriating.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    // Reading `messages.length` here makes the dependency real rather than a
    // bare trigger: a new message is exactly when the scroll must be re-pinned.
    if (!pinnedToBottom || messages.length === 0 || !element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages.length, pinnedToBottom]);

  // Typing indicator, with a stop signal on idle.
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(typingTimer.current), []);

  function handleDraftChange(value: string) {
    setDraft(value);
    if (!socket) return;

    socket.send({ t: 'chat_typing', active: value.length > 0 });
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      socket.send({ t: 'chat_typing', active: false });
    }, 2500);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !socket) return;

    socket.send({ t: 'chat_send', body, replyTo: null, nonce: nonce() });
    setDraft('');
    socket.send({ t: 'chat_typing', active: false });
    setPinnedToBottom(true);
  }

  const typingNames = [...typing]
    .filter((id) => id !== self?.id)
    .map((id) => participants.find((p) => p.user.id === id)?.user.displayName)
    .filter((name): name is string => Boolean(name));

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Room chat">
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
          setPinnedToBottom(distance < 48);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        // A live region would announce every message in a busy room, which is
        // unusable. Chat is navigable instead, and mentions are announced.
        role="log"
        aria-live="off"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const message = messages[item.index];
            if (!message) return null;
            const previous = messages[item.index - 1];
            const grouped =
              previous?.author.id === message.author.id &&
              message.sentAt - previous.sentAt < 5 * 60_000 &&
              !message.system;

            return (
              <div
                key={message.id}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <MessageRow
                  message={message}
                  grouped={grouped}
                  mentionsMe={Boolean(self && message.mentions.includes(self.id))}
                />
              </div>
            );
          })}
        </div>
      </div>

      {typingNames.length > 0 ? (
        <p className="px-4 pb-1 text-2xs text-[var(--text-muted)]">
          {typingNames.slice(0, 2).join(' and ')}
          {typingNames.length > 2 ? ` and ${typingNames.length - 2} others` : ''}{' '}
          {typingNames.length === 1 ? 'is' : 'are'} typing…
        </p>
      ) : null}

      <div className="border-t border-[var(--border-subtle)] p-3">
        <div className="mb-2 flex gap-1">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React with ${emoji}`}
              onClick={() => socket?.send({ t: 'reaction_send', emoji })}
              className="grid size-7 place-items-center rounded-[var(--radius-sm)] text-sm transition-transform hover:scale-110 hover:bg-[var(--surface-hover)] active:scale-95"
            >
              {emoji}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={draft}
            onChange={(event) => handleDraftChange(event.target.value)}
            placeholder="Say something…"
            aria-label="Message"
            maxLength={2000}
            autoComplete="off"
          />
          <Button
            type="submit"
            variant="primary"
            size="icon"
            disabled={!draft.trim()}
            aria-label="Send"
          >
            <Send />
          </Button>
        </form>
      </div>
    </section>
  );
}

function MessageRow({
  message,
  grouped,
  mentionsMe,
}: {
  message: ChatMessage;
  grouped: boolean;
  mentionsMe: boolean;
}) {
  if (message.system) {
    return (
      <p className="px-1 py-1.5 text-center text-2xs text-[var(--text-muted)]">{message.body}</p>
    );
  }

  return (
    <div
      className={cn(
        'group flex gap-2.5 rounded-[var(--radius-sm)] px-1 py-1',
        mentionsMe && 'bg-[color-mix(in_oklch,var(--accent)_12%,transparent)]',
        grouped ? 'mt-0' : 'mt-2',
      )}
    >
      <div className="w-8 shrink-0">
        {grouped ? null : <Avatar user={message.author} size="sm" />}
      </div>

      <div className="min-w-0 flex-1">
        {grouped ? null : (
          <p className="flex items-baseline gap-2">
            <span className="truncate text-xs font-medium text-[var(--text-primary)]">
              {message.author.displayName}
            </span>
            <time
              dateTime={new Date(message.sentAt).toISOString()}
              className="shrink-0 text-2xs text-[var(--text-muted)]"
            >
              {formatClock(message.sentAt)}
            </time>
            {message.pinned ? (
              <Pin className="size-3 text-[var(--accent)]" aria-label="Pinned" />
            ) : null}
          </p>
        )}
        {/* Rendered as text, never as HTML. The body is user input and this is
            the only place it reaches the DOM. */}
        <p className="whitespace-pre-wrap break-words text-sm leading-snug text-[var(--text-secondary)]">
          {message.body}
        </p>
      </div>
    </div>
  );
}

/** Floating emoji bursts over the player. */
export function ReactionLayer() {
  const reactions = useRoomStore((state) => state.reactions);
  const dismiss = useRoomStore((state) => state.dismissReaction);

  useEffect(() => {
    if (reactions.length === 0) return;
    const timers = reactions.map((reaction) => setTimeout(() => dismiss(reaction.id), 2400));
    return () => timers.forEach(clearTimeout);
  }, [reactions, dismiss]);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 h-64 overflow-hidden"
      aria-hidden
    >
      {reactions.map((reaction, index) => (
        <span
          key={reaction.id}
          className="animate-reaction absolute bottom-4 text-2xl"
          style={{ left: `${12 + ((index * 17) % 70)}%` }}
        >
          {reaction.emoji}
        </span>
      ))}
    </div>
  );
}

export function ReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <SmilePlus className="size-4 text-[var(--text-muted)]" aria-hidden />
      {REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onPick(emoji)}
          aria-label={`React with ${emoji}`}
          className="rounded px-1 text-base transition-transform hover:scale-125"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
