import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { cn } from '~/lib/utils';

/**
 * Owned, not imported (ADR 0009).
 *
 * Two details that are easy to skip and immediately noticeable:
 * `active:scale` gives a physical press, and the disabled state keeps enough
 * contrast to stay readable rather than fading to invisible.
 */
const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium',
    'transition-[background,box-shadow,transform,opacity] duration-150',
    'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
    'focus-visible:outline-2 focus-visible:outline-offset-2',
    // Icons inside buttons should never be selectable or stretch.
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary: [
          'bg-[var(--accent)] text-[var(--accent-contrast)]',
          'shadow-[0_1px_0_0_oklch(1_0_0/0.2)_inset,0_6px_20px_-8px_var(--accent)]',
          'hover:brightness-110',
        ],
        secondary: [
          'bg-[var(--surface-hover)] text-[var(--text-primary)]',
          'border border-[var(--border-default)]',
          'hover:bg-[var(--surface-overlay)] hover:border-[var(--border-strong)]',
        ],
        ghost:
          'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
        glass: 'glass text-[var(--text-primary)] hover:brightness-125',
        danger: 'bg-danger-500 text-white hover:brightness-110',
        link: 'text-[var(--accent)] underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs rounded-[var(--radius-sm)] [&_svg]:size-3.5',
        md: 'h-10 px-4 text-sm rounded-[var(--radius-md)] [&_svg]:size-4',
        lg: 'h-12 px-6 text-base rounded-[var(--radius-lg)] [&_svg]:size-5',
        icon: 'size-10 rounded-[var(--radius-md)] [&_svg]:size-4',
        'icon-sm': 'size-8 rounded-[var(--radius-sm)] [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    if (asChild) {
      // `Slot` merges props onto exactly one child, so we must not inject a
      // spinner alongside it. A button rendering as a link is navigation, which
      // has no pending state to show anyway.
      return (
        <Slot ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props}>
          {children}
        </Slot>
      );
    }

    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        // Screen readers need to hear that a request is in flight; a spinner
        // alone communicates nothing to them.
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
