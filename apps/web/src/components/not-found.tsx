import { Link } from '@tanstack/react-router';
import { ArrowLeft, Compass } from 'lucide-react';
import { NotFoundIllustration } from '~/components/illustrations';
import { Button } from '~/components/ui/button';

export function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="flex max-w-md flex-col items-center gap-6 text-center">
        <NotFoundIllustration className="w-72 text-[var(--text-primary)]" />

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">This page slipped past the end</h1>
          <p className="text-sm text-[var(--text-muted)]">
            The room may have closed, or the link might have a typo. Both happen.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild variant="primary">
            <Link to="/">
              <ArrowLeft aria-hidden />
              Back home
            </Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/rooms">
              <Compass aria-hidden />
              Browse rooms
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
