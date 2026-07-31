import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Participant, QueueItem } from '@youtube-room/protocol';
import { Crown, GripVertical, Mic, MicOff, Plus, Shield, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { EmptyQueueIllustration } from '~/components/illustrations';
import { Avatar } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { Badge, EmptyState, Input } from '~/components/ui/field';
import { cn, formatDuration } from '~/lib/utils';
import type { RoomSocket } from '~/realtime/socket';
import { useParticipants, usePermissions, useQueue, useSelf } from '~/stores/room-store';

/** Shared queue with drag-and-drop reordering. */
export function QueuePanel({ socket }: { socket: RoomSocket | null }) {
  const queue = useQueue();
  const permissions = usePermissions();
  const [draft, setDraft] = useState('');
  const canManage = permissions?.canManageQueue ?? false;

  const sensors = useSensors(
    // A small activation distance so a tap to open still works on touch.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !socket) return;

    const toIndex = queue.findIndex((item) => item.id === over.id);
    if (toIndex === -1) return;

    // Fire the intent; the authoritative order arrives in the echo. Applying
    // it locally first would fight a concurrent drag by someone else.
    socket.send({ t: 'queue_move', itemId: String(active.id), toIndex });
  }

  function addVideo(event: React.FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value || !socket) return;

    socket.send({ t: 'queue_add', videoId: value, playNext: false });
    setDraft('');
    toast.success('Added to the queue');
  }

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Queue">
      {canManage ? (
        <form onSubmit={addVideo} className="flex gap-2 border-b border-[var(--border-subtle)] p-3">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Paste a YouTube link"
            aria-label="Add a video by URL"
            autoComplete="off"
            // The `/` shortcut finds this by attribute rather than by a ref
            // threaded down through three components.
            data-room-queue-input
          />
          <Button
            type="submit"
            variant="primary"
            size="icon"
            disabled={!draft.trim()}
            aria-label="Add"
          >
            <Plus />
          </Button>
        </form>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {queue.length === 0 ? (
          <EmptyState
            illustration={<EmptyQueueIllustration className="size-32 text-[var(--text-primary)]" />}
            title="Queue is empty"
            description={
              canManage ? 'Paste a link above to add something.' : 'Nothing lined up yet.'
            }
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={queue.map((item) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-1">
                {queue.map((item, index) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    index={index}
                    canManage={canManage}
                    onRemove={() => socket?.send({ t: 'queue_remove', itemId: item.id })}
                    onPlayNow={() =>
                      socket?.send({
                        t: 'sync_intent',
                        action: { kind: 'play_now', queueItemId: item.id },
                        version: 0,
                      })
                    }
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {canManage && queue.length > 1 ? (
        <div className="flex gap-2 border-t border-[var(--border-subtle)] p-3">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1"
            onClick={() => socket?.send({ t: 'queue_shuffle' })}
          >
            Shuffle
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 text-danger-500"
            onClick={() => socket?.send({ t: 'queue_clear' })}
          >
            <Trash2 />
            Clear
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function QueueRow({
  item,
  index,
  canManage,
  onRemove,
  onPlayNow,
}: {
  item: QueueItem;
  index: number;
  canManage: boolean;
  onRemove: () => void;
  onPlayNow: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !canManage,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group flex items-center gap-2 rounded-[var(--radius-md)] p-1.5',
        'transition-colors hover:bg-[var(--surface-hover)]',
        isDragging && 'z-10 opacity-80 shadow-[var(--shadow-lift)]',
      )}
    >
      {canManage ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${item.title}`}
          className="cursor-grab touch-none text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </button>
      ) : (
        <span className="w-4 text-center font-mono text-2xs text-[var(--text-muted)]" data-numeric>
          {index + 1}
        </span>
      )}

      <button
        type="button"
        onClick={onPlayNow}
        disabled={!canManage}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <img
          src={item.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="aspect-video w-16 shrink-0 rounded-[var(--radius-xs)] object-cover"
        />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-xs leading-tight text-[var(--text-primary)]">
            {item.title}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-[var(--text-muted)]">
            {item.durationSeconds > 0 ? (
              <span data-numeric>{formatDuration(item.durationSeconds)}</span>
            ) : null}
            <span className="truncate">· {item.addedBy.displayName}</span>
          </span>
        </span>
      </button>

      {canManage ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${item.title}`}
          onClick={onRemove}
          className="opacity-0 transition-opacity group-hover:opacity-100"
        >
          <X />
        </Button>
      ) : null}
    </li>
  );
}

/** Participants, with voice state and moderation. */
export function ParticipantsPanel({ socket }: { socket: RoomSocket | null }) {
  const participants = useParticipants();
  const permissions = usePermissions();
  const self = useSelf();

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Participants">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
        <span className="text-2xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          In the room
        </span>
        <Badge tone="neutral">
          <span data-numeric>{participants.length}</span>
        </Badge>
      </div>

      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {participants.map((participant) => (
          <ParticipantRow
            key={participant.user.id}
            participant={participant}
            isSelf={participant.user.id === self?.id}
            canModerate={permissions?.canKick ?? false}
            onKick={() => socket?.send({ t: 'kick_participant', userId: participant.user.id })}
          />
        ))}
      </ul>
    </section>
  );
}

function ParticipantRow({
  participant,
  isSelf,
  canModerate,
  onKick,
}: {
  participant: Participant;
  isSelf: boolean;
  canModerate: boolean;
  onKick: () => void;
}) {
  const { user, role, inVoice, muted, driftMs } = participant;

  return (
    <li className="group flex items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-[var(--surface-hover)]">
      <Avatar user={user} size="sm" speaking={inVoice && !muted} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">
            {user.displayName}
            {isSelf ? <span className="ml-1 text-[var(--text-muted)]">(you)</span> : null}
          </span>
          {role === 'host' ? (
            <Crown className="size-3 shrink-0 text-warning-500" aria-label="Host" />
          ) : role === 'moderator' ? (
            <Shield className="size-3 shrink-0 text-[var(--accent)]" aria-label="Moderator" />
          ) : null}
        </span>
        {/* Drift is shown per person: when someone says "I'm behind", this is
            the number that settles it. */}
        {driftMs !== null && Math.abs(driftMs) > 250 ? (
          <span className="text-2xs text-warning-500" data-numeric>
            {Math.round(Math.abs(driftMs))}ms off
          </span>
        ) : null}
      </span>

      {inVoice ? (
        muted ? (
          <MicOff className="size-3.5 text-[var(--text-muted)]" aria-label="Muted" />
        ) : (
          <Mic className="size-3.5 text-success-500" aria-label="Speaking" />
        )
      ) : null}

      {canModerate && !isSelf && role !== 'host' ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${user.displayName}`}
          onClick={onKick}
          className="opacity-0 transition-opacity group-hover:opacity-100"
        >
          <X className="text-danger-500" />
        </Button>
      ) : null}
    </li>
  );
}
