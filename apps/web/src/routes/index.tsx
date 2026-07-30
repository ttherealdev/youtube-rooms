import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight, Compass, Play, Users } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { HeroIllustration, Logo } from '~/components/illustrations';
import { Faq, Features, Reveal, SiteFooter, Testimonials } from '~/components/landing/sections';
import { Button } from '~/components/ui/button';
import { Badge, LiveDot } from '~/components/ui/field';

export const Route = createFileRoute('/')({
  component: LandingPage,
});

function LandingPage() {
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <Hero />
      <Features />
      <Testimonials />
      <Faq />
      <FinalCta />
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
        <Link to="/" aria-label="YouTube Room home">
          <Logo />
        </Link>

        <nav className="hidden items-center gap-1 text-sm md:flex">
          {[
            ['Features', '/#features'],
            ['FAQ', '/#faq'],
          ].map(([label, href]) => (
            <a
              key={label}
              href={href}
              className="rounded-[var(--radius-sm)] px-3 py-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/rooms">Browse</Link>
          </Button>
          <Button asChild variant="primary" size="sm">
            <Link to="/rooms/new">Create a room</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  const reduced = useReducedMotion();

  return (
    <section className="relative mx-auto w-full max-w-6xl px-6 pb-20 pt-16 sm:pt-24">
      <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <motion.div
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <Badge tone="accent">
              <LiveDot />
              Rooms are live now
            </Badge>
          </motion.div>

          <motion.h1
            className="mt-5 text-balance text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          >
            Watch together, <span className="text-gradient">actually in sync</span>
          </motion.h1>

          <motion.p
            className="mt-5 max-w-lg text-pretty text-lg leading-relaxed text-[var(--text-muted)]"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
          >
            Create a room, share one link, and everyone lands on the same frame — with voice, a
            shared queue and live chat. No accounts needed to join.
          </motion.p>

          <motion.div
            className="mt-8 flex flex-wrap items-center gap-3"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.18, ease: [0.16, 1, 0.3, 1] }}
          >
            <Button asChild variant="primary" size="lg">
              <Link to="/rooms/new">
                <Play aria-hidden />
                Start a room
              </Link>
            </Button>
            <Button asChild variant="secondary" size="lg">
              <Link to="/rooms">
                <Compass aria-hidden />
                Browse public rooms
              </Link>
            </Button>
          </motion.div>

          <motion.dl
            className="mt-10 flex flex-wrap gap-x-10 gap-y-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.28 }}
          >
            {[
              ['< 150 ms', 'p95 playback drift'],
              ['100', 'people per room'],
              ['0', 'accounts needed to join'],
            ].map(([value, label]) => (
              <div key={label}>
                <dt className="text-2xl font-semibold tracking-tight" data-numeric>
                  {value}
                </dt>
                <dd className="text-xs text-[var(--text-muted)]">{label}</dd>
              </div>
            ))}
          </motion.dl>
        </div>

        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        >
          <HeroIllustration className="w-full text-[var(--text-primary)]" />
        </motion.div>
      </div>

      <Reveal delay={0.1} className="mt-20">
        <RoomPreview />
      </Reveal>
    </section>
  );
}

/**
 * A static, non-interactive mock of the room UI.
 *
 * Deliberately not a live demo: a fake room that half-works undersells the
 * product more than an honest still does, and a real one would need a server
 * round trip on the landing page's critical path.
 */
function RoomPreview() {
  const participants = [
    { name: 'Anas Mohamed', initials: 'AM', hue: 295, speaking: true },
    { name: 'Sam Okafor', initials: 'SO', hue: 205, speaking: false },
    { name: 'Yuki Tanaka', initials: 'YT', hue: 38, speaking: false },
    { name: 'Priya Raman', initials: 'PR', hue: 152, speaking: false },
  ];

  return (
    <div className="overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border-default)] bg-[var(--surface-raised)] shadow-[var(--shadow-lift)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="flex gap-1.5" aria-hidden>
          {['oklch(0.65 0.19 22)', 'oklch(0.8 0.15 78)', 'oklch(0.74 0.17 152)'].map((c) => (
            <span key={c} className="size-2.5 rounded-full" style={{ background: c }} />
          ))}
        </div>
        <span className="ml-2 font-mono text-2xs text-[var(--text-muted)]">
          youtube.room/r/k3f9-2mxq-71ab
        </span>
      </div>

      <div className="grid gap-px bg-[var(--border-subtle)] md:grid-cols-[1fr_280px]">
        <div className="bg-[var(--surface-raised)] p-4">
          <div className="relative aspect-video overflow-hidden rounded-[var(--radius-lg)] bg-[var(--surface-base)]">
            <div
              className="absolute inset-0 opacity-40"
              style={{
                background:
                  'radial-gradient(ellipse at 50% 40%, var(--ambient-a), transparent 70%)',
              }}
              aria-hidden
            />
            <div className="absolute inset-x-4 bottom-4 space-y-2">
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full w-[58%] rounded-full bg-[var(--accent)]" />
              </div>
              <div className="flex items-center justify-between font-mono text-2xs text-[var(--text-muted)]">
                <span data-numeric>12:04</span>
                <span className="text-success-500">● in sync</span>
                <span data-numeric>20:41</span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4 bg-[var(--surface-raised)] p-4">
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              <Users className="size-3" aria-hidden /> In the room
            </p>
            <ul className="space-y-1.5">
              {participants.map((p) => (
                <li key={p.name} className="flex items-center gap-2.5">
                  <span
                    className={`grid size-7 place-items-center rounded-full text-[10px] font-semibold text-white ${
                      p.speaking ? 'ring-2 ring-success-500' : ''
                    }`}
                    style={{
                      backgroundImage: `linear-gradient(135deg, oklch(0.62 0.17 ${p.hue}), oklch(0.52 0.19 ${(p.hue + 48) % 360}))`,
                    }}
                    aria-hidden
                  >
                    {p.initials}
                  </span>
                  <span className="truncate text-xs text-[var(--text-secondary)]">{p.name}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
            {[
              ['Sam', 'this bit is incredible'],
              ['Yuki', 'wait rewind 10s'],
            ].map(([who, text]) => (
              <p key={text} className="text-xs">
                <span className="font-medium text-[var(--accent)]">{who}</span>{' '}
                <span className="text-[var(--text-muted)]">{text}</span>
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FinalCta() {
  return (
    <section className="mx-auto w-full max-w-4xl px-6 pb-24">
      <Reveal>
        <div className="relative overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border-default)] px-8 py-16 text-center">
          <div
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
              background:
                'radial-gradient(ellipse at 50% 0%, var(--ambient-a), transparent 65%), radial-gradient(ellipse at 80% 100%, var(--ambient-b), transparent 60%)',
            }}
            aria-hidden
          />
          <div className="relative">
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Your next watch party is one link away
            </h2>
            <p className="mx-auto mt-3 max-w-md text-pretty text-[var(--text-muted)]">
              Create a room in about five seconds. Share it. That is the whole setup.
            </p>
            <Button asChild variant="primary" size="lg" className="mt-8">
              <Link to="/rooms/new">
                Create a room
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
