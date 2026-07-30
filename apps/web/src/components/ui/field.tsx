import * as React from 'react';
import { cn } from '~/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-10 w-full rounded-[var(--radius-md)] px-3.5 text-sm',
        'bg-[var(--surface-base)] text-[var(--text-primary)]',
        'border border-[var(--border-default)]',
        'placeholder:text-[var(--text-muted)]',
        'transition-[border-color,box-shadow] duration-150',
        'hover:border-[var(--border-strong)]',
        'focus:border-[var(--accent)] focus:outline-none',
        'focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_25%,transparent)]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        invalid &&
          'border-danger-500 focus:border-danger-500 focus:shadow-[0_0_0_3px_oklch(0.648_0.208_22/0.25)]',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

/**
 * Label + control + error, wired together.
 *
 * The error is `role="alert"` and referenced by `aria-describedby` so it is
 * announced when it appears — a red string that only sighted users can find is
 * not a validation message.
 */
export function Field({
  label,
  error,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  error?: string | undefined;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
  className?: string;
}) {
  const errorId = `${htmlFor}-error`;
  const hintId = `${htmlFor}-hint`;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-[var(--text-secondary)]">
        {label}
      </label>

      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id: htmlFor,
            'aria-describedby': error ? errorId : hint ? hintId : undefined,
          })
        : children}

      {hint && !error ? (
        <p id={hintId} className="text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger-500">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'live' | 'warning';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-[var(--surface-hover)] text-[var(--text-secondary)]',
    accent: 'bg-[color-mix(in_oklch,var(--accent)_18%,transparent)] text-[var(--accent)]',
    success: 'bg-success-500/15 text-success-500',
    live: 'bg-live-500/15 text-live-500',
    warning: 'bg-warning-500/15 text-warning-500',
  } as const;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
        'text-2xs font-medium tracking-wide',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Pulsing dot for "live now". */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn('relative flex size-2', className)} aria-hidden>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-live-500 opacity-70" />
      <span className="relative inline-flex size-2 rounded-full bg-live-500" />
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-[var(--radius-sm)]', className)} aria-hidden />;
}

export function Panel({
  children,
  className,
  as: Component = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  as?: React.ElementType;
}) {
  return <Component className={cn('panel', className)}>{children}</Component>;
}

/**
 * Empty states carry an illustration, not just text — they are the moments a
 * new user is most likely to bounce.
 */
export function EmptyState({
  illustration,
  title,
  description,
  action,
  className,
}: {
  illustration?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 px-6 py-12 text-center',
        className,
      )}
    >
      {illustration ? <div className="opacity-90">{illustration}</div> : null}
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold text-[var(--text-primary)]">{title}</h3>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-[var(--text-muted)]">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
