import type { Participant, RoomRole } from '@playercn/protocol';
import { Crown, MoreVertical, Shield, Star, UserMinus, UserPlus } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { ScrollArea } from '~/components/ui/scroll-area';
import type { RoomSocket } from '~/realtime/socket';
import { useParticipants, usePermissions, useRoomStore, useSelf } from '~/stores/room-store';

/**
 * Who is in the room, and what the host can do about it.
 *
 * Rank order is host, then co-hosts, then everyone else by join time — the same
 * order the server promotes through when a host leaves, so the list doubles as
 * a preview of who inherits the room.
 */
export function ParticipantsPanel({ socket }: { socket: RoomSocket | null }) {
  const participants = useParticipants();
  const permissions = usePermissions();
  const self = useSelf();
  const room = useRoomStore((s) => s.room);

  const ranked = [...participants].sort(
    (a, b) => rank(a.role) - rank(b.role) || a.joinedAt - b.joinedAt,
  );

  return (
    <ScrollArea className="h-full">
      <ul className="divide-y">
        {ranked.map((participant) => (
          <ParticipantRow
            key={participant.user.id}
            participant={participant}
            isSelf={participant.user.id === self?.id}
            isSuccessor={room?.successorId === participant.user.id}
            canManageRoles={permissions?.canManageRoles ?? false}
            canKick={permissions?.canKick ?? false}
            canTransferHost={permissions?.canTransferHost ?? false}
            canDesignate={permissions?.canDesignateSuccessor ?? false}
            socket={socket}
          />
        ))}
      </ul>
    </ScrollArea>
  );
}

function rank(role: RoomRole): number {
  return role === 'host' ? 0 : role === 'cohost' ? 1 : 2;
}

function ParticipantRow({
  participant,
  isSelf,
  isSuccessor,
  canManageRoles,
  canKick,
  canTransferHost,
  canDesignate,
  socket,
}: {
  participant: Participant;
  isSelf: boolean;
  isSuccessor: boolean;
  canManageRoles: boolean;
  canKick: boolean;
  canTransferHost: boolean;
  canDesignate: boolean;
  socket: RoomSocket | null;
}) {
  const { user, role } = participant;
  const isHost = role === 'host';

  // Nobody may act on the host, and nobody may act on themselves — the server
  // enforces both, and showing the items anyway would only produce errors.
  const actionable = !isHost && !isSelf;
  const showMenu = actionable && (canManageRoles || canKick || canTransferHost || canDesignate);

  return (
    <li className="flex items-center gap-2.5 px-3 py-2">
      <Avatar className="size-7">
        {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
        <AvatarFallback
          className="text-[10px] text-white"
          style={{
            backgroundImage: `linear-gradient(135deg, oklch(0.62 0.17 ${user.avatarHue}), oklch(0.52 0.19 ${(user.avatarHue + 48) % 360}))`,
          }}
        >
          {user.initials}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm">
          <span className="truncate">{user.displayName}</span>
          {isSelf ? <span className="text-xs text-muted-foreground">(you)</span> : null}
        </p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {isHost ? (
            <>
              <Crown className="size-3" /> Host
            </>
          ) : role === 'cohost' ? (
            <>
              <Shield className="size-3" /> Co-host
            </>
          ) : (
            'Member'
          )}
          {isSuccessor ? (
            <Badge variant="secondary" className="ml-1 gap-1 px-1.5 py-0 text-[10px]">
              <Star className="size-2.5" /> Next in line
            </Badge>
          ) : null}
        </p>
      </div>

      {showMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label={`Manage ${user.displayName}`}>
                <MoreVertical className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {canManageRoles ? (
              role === 'cohost' ? (
                <DropdownMenuItem
                  onClick={() => socket?.send({ t: 'set_role', userId: user.id, role: 'member' })}
                >
                  <UserMinus className="size-4" />
                  Demote to member
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={() => socket?.send({ t: 'set_role', userId: user.id, role: 'cohost' })}
                >
                  <UserPlus className="size-4" />
                  Make co-host
                </DropdownMenuItem>
              )
            ) : null}

            {canDesignate ? (
              <DropdownMenuItem
                onClick={() =>
                  socket?.send({
                    t: 'designate_successor',
                    userId: isSuccessor ? null : user.id,
                  })
                }
              >
                <Star className="size-4" />
                {isSuccessor ? 'Remove as successor' : 'Set as successor'}
              </DropdownMenuItem>
            ) : null}

            {canTransferHost ? (
              <DropdownMenuItem
                onClick={() => socket?.send({ t: 'transfer_host', userId: user.id })}
              >
                <Crown className="size-4" />
                Make host now
              </DropdownMenuItem>
            ) : null}

            {canKick ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => socket?.send({ t: 'kick_participant', userId: user.id })}
                >
                  <UserMinus className="size-4" />
                  Remove from room
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}
