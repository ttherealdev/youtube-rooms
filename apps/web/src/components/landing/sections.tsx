import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { FeatureGlyph, Logo } from '~/components/illustrations';
import { Badge } from '~/components/ui/field';
import { cn } from '~/lib/utils';

/** Fade-and-rise on scroll, honouring reduced motion. */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.div
      className={className}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <Badge tone="accent">{eyebrow}</Badge>
      <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
        {title}
      </h2>
      {description ? (
        <p className="mt-3 text-pretty text-base text-[var(--text-muted)]">{description}</p>
      ) : null}
    </div>
  );
}

const FEATURES = [
  {
    kind: 'sync' as const,
    title: 'Sync that actually holds',
    body: 'The server owns the timeline; every player converges on it continuously. Drift is corrected by nudging playback speed, so nobody sees a stutter.',
    detail: 'p95 drift under 150 ms',
  },
  {
    kind: 'voice' as const,
    title: 'Talk while you watch',
    body: 'Peer-to-peer WebRTC voice with echo cancellation and noise suppression. Your audio never touches our servers.',
    detail: 'One hop, no relay',
  },
  {
    kind: 'queue' as const,
    title: 'A queue everyone shares',
    body: 'Drag to reorder, paste any YouTube link, vote to skip. Reordering is instant and never fights another person dragging at the same time.',
    detail: 'Conflict-free reordering',
  },
  {
    kind: 'chat' as const,
    title: 'Chat, reactions, the lot',
    body: 'Replies, mentions, pins and typing indicators — plus reaction bursts that float over the video without covering it.',
    detail: 'Realtime, ordered, persisted',
  },
];

export function Features() {
  return (
    <section id="features" className="mx-auto w-full max-w-6xl px-6 py-24">
      <Reveal>
        <SectionHeading
          eyebrow="Built for this"
          title="Everything a watch party needs, nothing it doesn't"
          description="Four things have to be excellent for a room to feel alive. These are those four."
        />
      </Reveal>

      <div className="mt-14 grid gap-4 sm:grid-cols-2">
        {FEATURES.map((feature, index) => (
          <Reveal key={feature.kind} delay={index * 0.06}>
            <article
              className={cn(
                'group relative h-full overflow-hidden rounded-[var(--radius-xl)] p-7',
                'bg-[var(--surface-raised)] border border-[var(--border-subtle)]',
                'transition-[border-color,transform] duration-300',
                'hover:-translate-y-0.5 hover:border-[var(--border-strong)]',
              )}
            >
              {/* Accent wash that only appears on hover, so the grid stays calm. */}
              <div
                className="pointer-events-none absolute -right-16 -top-16 size-40 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100"
                style={{ background: 'var(--ambient-a)' }}
                aria-hidden
              />
              <FeatureGlyph kind={feature.kind} className="size-11 text-[var(--text-primary)]" />
              <h3 className="mt-5 text-lg font-semibold tracking-tight">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">
                {feature.body}
              </p>
              <p className="mt-4 font-mono text-2xs uppercase tracking-wider text-[var(--accent)]">
                {feature.detail}
              </p>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

const TESTIMONIALS = [
  {
    quote:
      'We tried three of these before. This is the first one where nobody has to say "wait, are you at the same bit?"',
    name: 'Placeholder Name',
    role: 'Film club, weekly',
  },
  {
    quote:
      'Set up a room, dropped the link in the group chat, six people were in within a minute. No accounts, no faff.',
    name: 'Placeholder Name',
    role: 'Long-distance friends',
  },
  {
    quote:
      'The voice chat is genuinely good. It sounds like being in the same room instead of a conference call.',
    name: 'Placeholder Name',
    role: 'Study group',
  },
];

export function Testimonials() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-24">
      <Reveal>
        <SectionHeading eyebrow="Placeholders" title="What people would say" />
        <p className="mx-auto mt-3 max-w-md text-center text-xs text-[var(--text-muted)]">
          These are placeholder quotes. Replace them with real ones before launch — invented
          testimonials are not worth the trust they cost.
        </p>
      </Reveal>

      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {TESTIMONIALS.map((item, index) => (
          <Reveal key={item.quote} delay={index * 0.08}>
            <figure className="flex h-full flex-col justify-between rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-6">
              <blockquote className="text-sm leading-relaxed text-[var(--text-secondary)]">
                “{item.quote}”
              </blockquote>
              <figcaption className="mt-6 flex items-center gap-3">
                <span
                  className="size-9 rounded-full"
                  style={{
                    backgroundImage: `linear-gradient(135deg, oklch(0.62 0.17 ${index * 90 + 40}), oklch(0.5 0.19 ${index * 90 + 100}))`,
                  }}
                  aria-hidden
                />
                <span className="text-xs">
                  <span className="block font-medium text-[var(--text-primary)]">{item.name}</span>
                  <span className="block text-[var(--text-muted)]">{item.role}</span>
                </span>
              </figcaption>
            </figure>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

const FAQS = [
  {
    q: 'Do my friends need an account?',
    a: 'No. Anyone with the link picks a display name and joins straight away. Signing in with Google is only needed to create and own a room.',
  },
  {
    q: 'How is playback kept in sync?',
    a: 'The server holds the authoritative timeline and every player continuously measures itself against it. Small differences are corrected by adjusting playback speed by a few percent — imperceptible — and only a large gap causes an actual seek.',
  },
  {
    q: 'Is my voice audio going through your servers?',
    a: 'No. Voice is peer-to-peer WebRTC, so audio flows directly between participants. Our server only relays the initial connection handshake.',
  },
  {
    q: 'How many people fit in a room?',
    a: 'Up to 100 can watch and chat. Voice defaults to 8, because peer-to-peer audio stops being practical above that on typical home connections.',
  },
  {
    q: 'Can I self-host it?',
    a: 'Yes. The whole stack is two containers plus Postgres and Redis, with a compose file and a Dokploy template included.',
  },
  {
    q: 'Does it work on my phone?',
    a: 'Yes. The room layout collapses to a stacked view with the player pinned and chat in a sheet. Mobile browsers restrict autoplay, so you may need to tap once to start.',
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="mx-auto w-full max-w-3xl px-6 py-24">
      <Reveal>
        <SectionHeading eyebrow="Questions" title="The things people ask first" />
      </Reveal>

      <div className="mt-12 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
        {FAQS.map((item, index) => {
          const expanded = open === index;
          return (
            <div key={item.q}>
              <h3>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : index)}
                  aria-expanded={expanded}
                  aria-controls={`faq-panel-${index}`}
                  className="flex w-full items-center justify-between gap-4 py-5 text-left"
                >
                  <span className="text-sm font-medium">{item.q}</span>
                  <ChevronDown
                    className={cn(
                      'size-4 shrink-0 text-[var(--text-muted)] transition-transform duration-200',
                      expanded && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </button>
              </h3>
              <div
                id={`faq-panel-${index}`}
                hidden={!expanded}
                className="pb-5 text-sm leading-relaxed text-[var(--text-muted)]"
              >
                {item.a}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--border-subtle)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-12 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-xs space-y-3">
          <Logo />
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">
            Watch YouTube together, perfectly in sync. Open source and self-hostable.
          </p>
        </div>

        <nav className="grid grid-cols-2 gap-x-12 gap-y-2 text-xs sm:grid-cols-3">
          {[
            {
              heading: 'Product',
              links: [
                ['Browse rooms', '/rooms'],
                ['Features', '/#features'],
                ['FAQ', '/#faq'],
              ],
            },
            {
              heading: 'Project',
              links: [
                ['Architecture', '/#features'],
                ['Self-hosting', '/#faq'],
              ],
            },
          ].map((group) => (
            <div key={group.heading} className="space-y-2">
              <p className="font-medium text-[var(--text-primary)]">{group.heading}</p>
              <ul className="space-y-1.5">
                {group.links.map(([label, href]) => (
                  <li key={label}>
                    <Link
                      to={href ?? '/'}
                      className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className="mx-auto w-full max-w-6xl px-6 pb-10">
        <p className="text-2xs text-[var(--text-muted)]">
          Not affiliated with YouTube or Google. Video is played through the official YouTube
          embedded player.
        </p>
      </div>
    </footer>
  );
}
