'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { ModeToggle, ThemeCustomizer } from '~/components/theme-customizer';
import { Button } from '~/components/ui/button';

export function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-6 py-3">
        <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
          playercn
        </Link>

        {children}

        <span className="flex-1" />

        <ModeToggle />
        <ThemeCustomizer />

        <Button
          render={<Link href="/rooms" />}
          size="sm"
          variant="ghost"
          className="hidden sm:inline-flex"
        >
          Browse
        </Button>
        <Button render={<Link href="/rooms/new" />} size="sm">
          <Plus className="size-4" />
          <span className="hidden sm:inline">New room</span>
        </Button>
      </div>
    </header>
  );
}
