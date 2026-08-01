import { LogOut, Pencil, UserRound } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Spinner } from '~/components/ui/spinner';
import { useSession } from '~/hooks/use-session';

/**
 * Identity, and the ability to change it.
 *
 * A guest picks a name once at the join gate, and before this menu existed
 * there was no way to correct a typo short of clearing storage. Renaming is
 * therefore first-class here rather than buried in a settings page — for guests
 * the name *is* the whole account.
 */
export function AccountMenu() {
  const { state, signInWithGoogle, signOut } = useSession();
  const [renaming, setRenaming] = useState(false);

  if (state.status === 'loading') {
    return <div className="size-7 animate-pulse rounded-full bg-muted" aria-hidden />;
  }

  if (state.status === 'anonymous') {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          signInWithGoogle(
            typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search,
          )
        }
      >
        <UserRound className="size-4" />
        <span className="hidden sm:inline">Sign in</span>
      </Button>
    );
  }

  const { user } = state;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Account" className="rounded-full">
              <Avatar className="size-7">
                {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
                <AvatarFallback
                  style={{ backgroundColor: `oklch(0.72 0.12 ${user.avatarHue})` }}
                  className="text-[11px] font-medium text-black/80"
                >
                  {user.initials}
                </AvatarFallback>
              </Avatar>
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-56">
          {/* The label is a `GroupLabel`, which throws outside a `Group` — it
              is labelling something, and the primitive insists on being told
              what. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate text-sm font-medium">{user.displayName}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {user.kind === 'guest' ? 'Guest — this device only' : 'Google account'}
              </span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <Pencil className="size-4" />
            Change name
          </DropdownMenuItem>
          {user.kind === 'guest' ? (
            <DropdownMenuItem
              onClick={() =>
                signInWithGoogle(
                  typeof window === 'undefined'
                    ? '/'
                    : window.location.pathname + window.location.search,
                )
              }
            >
              <UserRound className="size-4" />
              Sign in with Google
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void signOut()}>
            <LogOut className="size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog open={renaming} onOpenChange={setRenaming} current={user.displayName} />
    </>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
}) {
  const { rename } = useSession();
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();

    if (trimmed.length < 2 || trimmed.length > 32) {
      setError('Use between 2 and 32 characters.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await rename(trimmed);
      toast.success('Name updated');
      onOpenChange(false);
    } catch {
      setError('Could not change your name. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reopening after a cancel should start from the current name again,
        // not from the half-edited value that was abandoned.
        if (next) setValue(current);
        setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Change your name</DialogTitle>
            <DialogDescription>
              This is how everyone in a room sees you. It updates for people you are watching with
              straight away.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5 py-4">
            <Label htmlFor="new-display-name">Display name</Label>
            <Input
              id="new-display-name"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={32}
              autoComplete="nickname"
              aria-invalid={Boolean(error)}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner className="size-4" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
