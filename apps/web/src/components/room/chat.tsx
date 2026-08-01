import type { ChatMessage } from '@playercn/protocol';
import { ArrowDown, CornerUpLeft, Reply, Send, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import { cn } from '~/lib/utils';
import type { RoomSocket } from '~/realtime/socket';
import { useMessages, useSelf } from '~/stores/room-store';

/**
 * Room chat.
 *
 * Autoscroll follows only while the reader is already at the bottom. Scrolling
 * someone back to the newest message while they are reading history is the
 * single most irritating thing a chat panel can do — so when new messages
 * arrive during that, they are announced with a button instead.
 */
export function ChatPanel({
  socket,
  inputRef,
}: {
  socket: RoomSocket | null;
  /** Handed down so the room's `c` shortcut can put the cursor here. */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const messages = useMessages();
  const self = useSelf();
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [behind, setBehind] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLTextAreaElement>(null);
  const composer = inputRef ?? localRef;
  const pinnedToBottom = useRef(true);

  // Lookup for reply previews. Rebuilt per message list rather than searched
  // per bubble, which would be quadratic on a busy room.
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  const toBottom = useCallback((behaviour: ScrollBehavior = 'smooth') => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: behaviour });
    pinnedToBottom.current = true;
    setBehind(false);
  }, []);

  // `messages` is the trigger rather than a value the body reads: the effect
  // exists to re-run after every new message so the view follows it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on new messages
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (pinnedToBottom.current) node.scrollTop = node.scrollHeight;
    else setBehind(true);
  }, [messages]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const onScroll = () => {
      // A few pixels of slack: browsers report fractional scroll positions and
      // an exact comparison is never true on a zoomed or high-DPI display.
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      pinnedToBottom.current = distance < 48;
      if (pinnedToBottom.current) setBehind(false);
    };

    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  const jumpTo = useCallback((id: string) => {
    const node = document.getElementById(`msg-${id}`);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // A brief ring rather than a persistent selection: it answers "which one?"
    // and then gets out of the way.
    node.dataset.flash = 'true';
    window.setTimeout(() => {
      delete node.dataset.flash;
    }, 1200);
  }, []);

  const send = () => {
    const body = draft.trim();
    if (!body || !socket) return;

    socket.send({
      t: 'chat_send',
      body,
      replyTo: replyTo?.id ?? null,
      // Echoed back so the optimistic bubble is replaced rather than duplicated.
      nonce: crypto.randomUUID(),
    });
    setDraft('');
    setReplyTo(null);
    pinnedToBottom.current = true;
  };

  const startReply = useCallback(
    (message: ChatMessage) => {
      setReplyTo(message);
      composer.current?.focus();
    },
    [composer],
  );

  return (
    <div className="relative flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-0.5 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No messages yet. Say something.
          </p>
        ) : (
          messages.map((message, index) => (
            <MessageRow
              key={message.id}
              message={message}
              parent={message.replyTo ? (byId.get(message.replyTo) ?? null) : null}
              isSelf={message.author.id === self?.id}
              // Consecutive lines from one person read as one turn in a
              // conversation, so only the first carries a name and an avatar.
              grouped={continues(messages[index - 1], message)}
              onReply={() => startReply(message)}
              onJump={jumpTo}
            />
          ))
        )}
      </div>

      {behind ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => toBottom()}
          className="absolute inset-x-0 bottom-24 mx-auto w-fit shadow-md"
        >
          <ArrowDown className="size-3.5" />
          New messages
        </Button>
      ) : null}

      <div className="border-t">
        {replyTo ? (
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
            <CornerUpLeft className="size-3.5 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              Replying to <span className="font-medium">{replyTo.author.displayName}</span> ·{' '}
              {replyTo.body}
            </p>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Cancel reply"
              onClick={() => setReplyTo(null)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
          className="flex items-end gap-2 p-3"
        >
          <Textarea
            ref={composer}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line. The opposite is
              // correct for a document and wrong for a chat.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
              if (event.key === 'Escape' && replyTo) setReplyTo(null);
            }}
            placeholder={replyTo ? `Reply to ${replyTo.author.displayName}` : 'Message'}
            maxLength={2000}
            rows={1}
            aria-label="Message"
            className="max-h-32 min-h-9 resize-none py-2"
          />
          <Button type="submit" size="icon" aria-label="Send" disabled={!draft.trim()}>
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}

/** Is this message a continuation of the one before it? */
function continues(previous: ChatMessage | undefined, message: ChatMessage): boolean {
  if (!previous || previous.system || message.system) return false;
  if (previous.author.id !== message.author.id) return false;
  if (message.replyTo) return false;
  // Five minutes: long enough to cover a pause mid-thought, short enough that
  // a reply hours later starts a new turn.
  return message.sentAt - previous.sentAt < 5 * 60_000;
}

function MessageRow({
  message,
  parent,
  isSelf,
  grouped,
  onReply,
  onJump,
}: {
  message: ChatMessage;
  parent: ChatMessage | null;
  isSelf: boolean;
  grouped: boolean;
  onReply: () => void;
  onJump: (id: string) => void;
}) {
  // System lines are the room narrating itself — joins, host changes, skips —
  // and read as events rather than as something "Room" said.
  if (message.system) {
    return <p className="py-1 text-center text-xs text-muted-foreground italic">{message.body}</p>;
  }

  const { author } = message;

  return (
    <div
      id={`msg-${message.id}`}
      className={cn(
        'group/msg -mx-1 flex items-start gap-2 rounded-md px-1 py-0.5 transition-colors',
        'hover:bg-accent/40 data-flash:bg-primary/15',
      )}
    >
      <div className="w-6 shrink-0">
        {grouped ? null : (
          <Avatar className="size-6">
            {author.avatarUrl ? <AvatarImage src={author.avatarUrl} alt="" /> : null}
            <AvatarFallback
              className="text-[9px] text-white"
              style={{
                backgroundImage: `linear-gradient(135deg, oklch(0.62 0.17 ${author.avatarHue}), oklch(0.52 0.19 ${(author.avatarHue + 48) % 360}))`,
              }}
            >
              {author.initials}
            </AvatarFallback>
          </Avatar>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {parent ? (
          <button
            type="button"
            onClick={() => onJump(parent.id)}
            className="mb-0.5 flex w-full min-w-0 items-center gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
          >
            <CornerUpLeft className="size-3 shrink-0" />
            <span className="shrink-0 font-medium">{parent.author.displayName}</span>
            <span className="truncate opacity-80">{parent.body}</span>
          </button>
        ) : null}

        {grouped ? null : (
          <p className="flex items-baseline gap-1.5">
            <span className={cn('text-xs font-medium', isSelf && 'text-primary')}>
              {author.displayName}
            </span>
            <time
              dateTime={new Date(message.sentAt).toISOString()}
              className="text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100"
            >
              {clockTime(message.sentAt)}
            </time>
          </p>
        )}

        <p className="text-sm break-words whitespace-pre-wrap">{message.body}</p>
      </div>

      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Reply to ${author.displayName}`}
        title="Reply"
        onClick={onReply}
        className="shrink-0 opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100"
      >
        <Reply className="size-3.5" />
      </Button>
    </div>
  );
}

function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}
