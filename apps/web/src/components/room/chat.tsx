import type { ChatMessage } from '@playercn/protocol';
import { Send } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { cn } from '~/lib/utils';
import type { RoomSocket } from '~/realtime/socket';
import { useMessages, useSelf } from '~/stores/room-store';

/**
 * Room chat.
 *
 * Autoscroll follows only while the reader is already at the bottom. Scrolling
 * someone back to the newest message while they are reading history is the
 * single most irritating thing a chat panel can do.
 */
export function ChatPanel({ socket }: { socket: RoomSocket | null }) {
  const messages = useMessages();
  const self = useSelf();
  const [draft, setDraft] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // `messages` is the trigger rather than a value the body reads: the effect
  // exists to re-run after every new message so the view follows it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on new messages
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const onScroll = () => {
      // A few pixels of slack: browsers report fractional scroll positions and
      // an exact comparison is never true on a zoomed or high-DPI display.
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      pinnedToBottom.current = distance < 48;
    };

    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !socket) return;

    socket.send({
      t: 'chat_send',
      body,
      replyTo: null,
      // Echoed back so the optimistic bubble is replaced rather than duplicated.
      nonce: crypto.randomUUID(),
    });
    setDraft('');
    pinnedToBottom.current = true;
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No messages yet. Say something.
          </p>
        ) : (
          messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              isSelf={message.author.id === self?.id}
            />
          ))
        )}
      </div>

      <form onSubmit={submit} className="flex gap-2 border-t p-3">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Message"
          maxLength={2000}
          autoComplete="off"
          aria-label="Message"
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={!draft.trim()}>
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  );
}

function MessageRow({ message, isSelf }: { message: ChatMessage; isSelf: boolean }) {
  // System lines are the room narrating itself — joins, host changes, skips —
  // and read as events rather than as something "Room" said.
  if (message.system) {
    return (
      <p className="py-0.5 text-center text-xs text-muted-foreground italic">{message.body}</p>
    );
  }

  const { author } = message;

  return (
    <div className="flex items-start gap-2">
      <Avatar className="size-6 shrink-0">
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

      <div className="min-w-0 flex-1">
        <p className={cn('text-xs font-medium', isSelf && 'text-primary')}>{author.displayName}</p>
        <p className="text-sm break-words whitespace-pre-wrap">{message.body}</p>
      </div>
    </div>
  );
}
