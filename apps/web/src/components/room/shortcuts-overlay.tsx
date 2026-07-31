import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { SHORTCUTS } from '~/hooks/use-room-shortcuts';
import { cn } from '~/lib/utils';
import { usePermissions } from '~/stores/room-store';

/**
 * The `?` overlay.
 *
 * Bindings that only the host can use are dimmed rather than hidden: a guest
 * who presses Space and sees nothing happen should be able to find out why,
 * which a list that quietly omits the key cannot tell them.
 */
export function ShortcutsOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const permissions = usePermissions();
  const canControl = permissions?.canControlPlayback ?? false;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(34rem,calc(100vw-2rem))]',
            '-translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-xl)]',
            'border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 shadow-2xl',
            'focus:outline-none',
          )}
        >
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-sm font-medium">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>

          <Dialog.Description className="sr-only">
            Every keyboard shortcut available inside a room.
          </Dialog.Description>

          <div className="grid gap-5 sm:grid-cols-2">
            {SHORTCUTS.map((group) => (
              <section key={group.group}>
                <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  {group.group}
                </h3>
                <ul className="space-y-1.5">
                  {group.items.map((item) => {
                    const unavailable = item.hostOnly && !canControl;
                    return (
                      <li
                        key={item.label}
                        className={cn(
                          'flex items-center justify-between gap-3 text-xs',
                          unavailable && 'opacity-45',
                        )}
                      >
                        <span className="text-[var(--text-secondary)]">
                          {item.label}
                          {unavailable ? (
                            <span className="ml-1 text-[var(--text-muted)]">(host only)</span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {item.keys.map((key) =>
                            key === '–' ? (
                              <span key={key} className="text-2xs text-[var(--text-muted)]">
                                –
                              </span>
                            ) : (
                              <kbd
                                key={key}
                                className={cn(
                                  'rounded border border-[var(--border-subtle)] bg-[var(--surface-hover)]',
                                  'px-1.5 py-0.5 font-mono text-2xs text-[var(--text-primary)]',
                                )}
                              >
                                {key}
                              </kbd>
                            ),
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>

          <p className="mt-5 text-2xs text-[var(--text-muted)]">
            Shortcuts are ignored while you are typing in chat or the queue box.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
