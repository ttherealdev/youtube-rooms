import { Check, Monitor, Moon, Palette, Sun } from 'lucide-react';
import { useState } from 'react';
import { useTheme } from '~/components/theme-provider';
import { Button } from '~/components/ui/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '~/components/ui/drawer';
import { THEMES, type ThemeKey, type ThemeMeta, type ThemeMode } from '~/lib/themes';
import { cn } from '~/lib/utils';

/**
 * The appearance picker.
 *
 * Deliberately a drawer rather than a settings page: choosing a theme is a
 * judgement about how the app looks, so the app has to stay visible while you
 * make it. Every swatch applies immediately for the same reason — a preview
 * that requires a Save button is not a preview.
 */
export function ThemeCustomizer({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const { theme, mode, overridden, setTheme, setMode } = useTheme();

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Change appearance" className={className}>
            <Palette className="size-4" />
          </Button>
        }
      />

      <DrawerContent className="mx-auto max-w-2xl">
        <DrawerHeader>
          <DrawerTitle>Appearance</DrawerTitle>
          <DrawerDescription>
            {overridden
              ? 'This room sets its own theme. Your choice here applies everywhere else.'
              : 'Pick a palette and a mode. Saved on this device.'}
          </DrawerDescription>
        </DrawerHeader>

        <div className="space-y-6 overflow-y-auto px-4 pb-2">
          <section>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Mode
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
              {(
                [
                  ['light', 'Light', Sun],
                  ['dark', 'Dark', Moon],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value as ThemeMode)}
                  aria-pressed={mode === value}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                    mode === value
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Theme
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {THEMES.map((entry) => (
                <ThemeSwatch
                  key={entry.key}
                  theme={entry}
                  mode={mode}
                  selected={theme === entry.key}
                  onSelect={setTheme}
                />
              ))}
            </div>
          </section>
        </div>

        <DrawerFooter>
          <DrawerClose render={<Button variant="outline">Done</Button>} />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function ThemeSwatch({
  theme,
  mode,
  selected,
  onSelect,
}: {
  theme: ThemeMeta;
  mode: ThemeMode;
  selected: boolean;
  onSelect: (key: ThemeKey) => void;
}) {
  // Preview in the mode the user is actually in, so the swatch matches what
  // picking it will do.
  const [background, surface, primary] = mode === 'dark' ? theme.dark : theme.light;

  return (
    <button
      type="button"
      onClick={() => onSelect(theme.key)}
      aria-pressed={selected}
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border p-3 text-left transition-all',
        selected
          ? 'border-primary ring-2 ring-primary/25'
          : 'border-border hover:border-foreground/25',
      )}
    >
      <span
        className="flex h-12 w-full items-end gap-1 overflow-hidden rounded-md border border-black/5 p-1.5"
        style={{ background }}
        aria-hidden
      >
        <span className="h-full flex-1 rounded-sm" style={{ background: surface }} />
        <span className="h-full w-1/3 rounded-sm" style={{ background: primary }} />
      </span>

      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{theme.label}</span>
          <span className="block truncate text-xs text-muted-foreground">{theme.description}</span>
        </span>
        {selected ? <Check className="size-4 shrink-0 text-primary" /> : null}
      </span>
    </button>
  );
}

/** Compact mode toggle for headers, where the full drawer is too much. */
export function ModeToggle({ className }: { className?: string }) {
  const { mode, toggleMode } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleMode}
      aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className={className}
    >
      {mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

export { Monitor };
