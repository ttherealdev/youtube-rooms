import type { UserSummary } from '@youtube-room/protocol';
import { avatarGradient, cn } from '~/lib/utils';

const sizes = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-lg',
  xl: 'size-20 text-2xl',
} as const;

interface AvatarProps {
  user: Pick<UserSummary, 'displayName' | 'avatarUrl' | 'initials' | 'avatarHue'>;
  size?: keyof typeof sizes;
  /** Green ring + pulse while this person is talking. */
  speaking?: boolean;
  className?: string;
}

/**
 * Avatar with a deterministic generated fallback.
 *
 * The initials gradient is derived from the user's id on the server, so the
 * same person is the same colour everywhere and across sessions without us
 * storing an image for guests — which is most of our users.
 */
export function Avatar({ user, size = 'md', speaking, className }: AvatarProps) {
  const hasImage = Boolean(user.avatarUrl);

  return (
    <span
      className={cn(
        'relative inline-grid place-items-center overflow-hidden rounded-full',
        'font-semibold text-white select-none',
        'ring-1 ring-[var(--border-default)]',
        speaking && 'ring-2 ring-success-500 animate-speaking',
        sizes[size],
        className,
      )}
      style={hasImage ? undefined : { backgroundImage: avatarGradient(user.avatarHue) }}
    >
      {hasImage ? (
        <img
          // The avatar is decorative next to the name it always accompanies;
          // an alt here would make screen readers announce the name twice.
          alt=""
          src={user.avatarUrl ?? ''}
          className="size-full object-cover"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span aria-hidden>{user.initials}</span>
      )}
    </span>
  );
}

/** Overlapping stack for participant previews on room cards. */
export function AvatarStack({
  users,
  max = 4,
  size = 'sm',
}: {
  users: UserSummary[];
  max?: number;
  size?: keyof typeof sizes;
}) {
  const shown = users.slice(0, max);
  const overflow = users.length - shown.length;

  return (
    <div className="flex items-center -space-x-2">
      {shown.map((user) => (
        <Avatar
          key={user.id}
          user={user}
          size={size}
          className="ring-2 ring-[var(--surface-raised)]"
        />
      ))}
      {overflow > 0 ? (
        <span
          className={cn(
            'grid place-items-center rounded-full bg-[var(--surface-hover)]',
            'text-[var(--text-secondary)] font-medium ring-2 ring-[var(--surface-raised)]',
            sizes[size],
          )}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}
