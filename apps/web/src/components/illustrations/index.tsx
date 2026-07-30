/**
 * Hand-authored SVG illustrations.
 *
 * Deliberately not from an icon library (the brief asks for this, and it is
 * right): these carry the product's personality where a generic pictogram
 * would make every empty state look like everyone else's.
 *
 * Rules every illustration here follows:
 *   * `currentColor` and theme tokens only — they adapt to light, dark and
 *     every room theme with no variants to maintain.
 *   * `aria-hidden` by default; the surrounding `EmptyState` supplies the text.
 *   * No external requests, so they cost nothing after the JS is parsed.
 */

interface IllustrationProps {
  className?: string;
  /** Rendered size. Illustrations are authored on a 200×160 viewBox. */
  width?: number;
}

const ACCENT = 'var(--accent)';

/** Wordmark + glyph. The glyph is a play triangle inside a speech bubble —
 *  watching, together — and doubles as the favicon. */
export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ''}`}>
      <svg viewBox="0 0 32 32" className="size-8" role="img" aria-label="YouTube Room">
        <defs>
          <linearGradient id="logo-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={ACCENT} />
            <stop offset="100%" stopColor="var(--color-cyan-500)" />
          </linearGradient>
        </defs>
        <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="url(#logo-grad)" />
        <path
          d="M12.2 10.6a1 1 0 0 1 1.52-.85l7.1 4.4a1 1 0 0 1 0 1.7l-7.1 4.4a1 1 0 0 1-1.52-.85z"
          fill="white"
          fillOpacity="0.95"
        />
        <circle cx="16" cy="25.5" r="1.4" fill="white" fillOpacity="0.6" />
      </svg>
      {showWordmark ? (
        <span className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">
          YouTube Room
        </span>
      ) : null}
    </span>
  );
}

/**
 * Landing hero: a player frame with three orbiting participant bubbles and a
 * shared progress line, all in perfect step. The illustration *is* the pitch.
 */
export function HeroIllustration({ className }: IllustrationProps) {
  return (
    <svg viewBox="0 0 420 300" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id="hero-screen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-cyan-500)" stopOpacity="0.14" />
        </linearGradient>
        <linearGradient id="hero-bar" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={ACCENT} />
          <stop offset="100%" stopColor="var(--color-cyan-400)" />
        </linearGradient>
        <filter id="hero-soft" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>

      {/* Ambient wash behind the frame */}
      <ellipse
        cx="210"
        cy="140"
        rx="150"
        ry="90"
        fill={ACCENT}
        opacity="0.16"
        filter="url(#hero-soft)"
      />

      {/* Player frame */}
      <rect x="70" y="52" width="280" height="158" rx="14" fill="url(#hero-screen)" />
      <rect
        x="70.5"
        y="52.5"
        width="279"
        height="157"
        rx="13.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.18"
      />

      {/* Play glyph */}
      <circle cx="210" cy="126" r="30" fill="currentColor" fillOpacity="0.06" />
      <path
        d="M201 113.5a1.5 1.5 0 0 1 2.29-1.28l19 12.5a1.5 1.5 0 0 1 0 2.56l-19 12.5a1.5 1.5 0 0 1-2.29-1.28z"
        fill={ACCENT}
      />

      {/* Shared scrub line — the same head for everyone */}
      <rect x="94" y="188" width="232" height="4" rx="2" fill="currentColor" fillOpacity="0.14" />
      <rect x="94" y="188" width="138" height="4" rx="2" fill="url(#hero-bar)" />
      <circle
        cx="232"
        cy="190"
        r="6"
        fill="var(--surface-base)"
        stroke="url(#hero-bar)"
        strokeWidth="2.5"
      />

      {/* Participants, tethered to the same head */}
      {[
        { cx: 62, cy: 92, hue: 295, delay: '0s' },
        { cx: 358, cy: 104, hue: 205, delay: '0.4s' },
        { cx: 108, cy: 244, hue: 38, delay: '0.8s' },
      ].map((peer) => (
        <g key={peer.cx}>
          <line
            x1={peer.cx}
            y1={peer.cy}
            x2="232"
            y2="190"
            stroke="currentColor"
            strokeOpacity="0.13"
            strokeDasharray="3 5"
          />
          <circle
            cx={peer.cx}
            cy={peer.cy}
            r="19"
            fill={`oklch(0.6 0.17 ${peer.hue})`}
            fillOpacity="0.9"
          />
          <circle
            cx={peer.cx}
            cy={peer.cy}
            r="19"
            fill="none"
            stroke={`oklch(0.75 0.15 ${peer.hue})`}
            strokeOpacity="0.5"
            strokeWidth="1.5"
          />
        </g>
      ))}

      {/* Chat tick, bottom right */}
      <g opacity="0.85">
        <rect
          x="300"
          y="230"
          width="76"
          height="30"
          rx="12"
          fill="var(--surface-raised)"
          stroke="currentColor"
          strokeOpacity="0.14"
        />
        {[314, 330, 346].map((cx, index) => (
          <circle
            key={cx}
            cx={cx}
            cy="245"
            r="3"
            fill="currentColor"
            fillOpacity={0.28 + index * 0.18}
          />
        ))}
      </g>
    </svg>
  );
}

/** Empty queue: a stack of cards with nothing in the slot. */
export function EmptyQueueIllustration({ className }: IllustrationProps) {
  return (
    <svg viewBox="0 0 200 150" className={className ?? 'size-40'} aria-hidden focusable="false">
      <rect x="44" y="30" width="112" height="22" rx="7" fill="currentColor" fillOpacity="0.05" />
      <rect x="36" y="58" width="128" height="22" rx="7" fill="currentColor" fillOpacity="0.08" />
      <rect
        x="28"
        y="86"
        width="144"
        height="34"
        rx="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeDasharray="6 6"
      />
      <path d="M100 96v14M93 103h14" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Nothing playing: a dark screen with a dormant play glyph. */
export function NoVideoIllustration({ className }: IllustrationProps) {
  return (
    <svg viewBox="0 0 200 150" className={className ?? 'size-44'} aria-hidden focusable="false">
      <rect x="24" y="26" width="152" height="88" rx="11" fill="currentColor" fillOpacity="0.05" />
      <rect
        x="24.5"
        y="26.5"
        width="151"
        height="87"
        rx="10.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.16"
      />
      <circle cx="100" cy="70" r="22" fill="currentColor" fillOpacity="0.06" />
      <path
        d="M94 61.5a1.2 1.2 0 0 1 1.83-1.02l13 8.5a1.2 1.2 0 0 1 0 2.04l-13 8.5A1.2 1.2 0 0 1 94 78.5z"
        fill="currentColor"
        fillOpacity="0.32"
      />
      <rect x="52" y="128" width="96" height="5" rx="2.5" fill="currentColor" fillOpacity="0.1" />
    </svg>
  );
}

/** Voice disconnected: a struck-through microphone with a broken link. */
export function VoiceDisconnectedIllustration({ className }: IllustrationProps) {
  return (
    <svg viewBox="0 0 200 150" className={className ?? 'size-36'} aria-hidden focusable="false">
      <circle cx="100" cy="72" r="46" fill="var(--color-danger-500)" opacity="0.08" />
      <rect x="88" y="44" width="24" height="42" rx="12" fill="currentColor" fillOpacity="0.28" />
      <path
        d="M74 78a26 26 0 0 0 52 0"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.28"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M100 104v14"
        stroke="currentColor"
        strokeOpacity="0.28"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M66 38 134 106"
        stroke="var(--color-danger-500)"
        strokeWidth="5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Waiting room: chairs around a screen that has not started. */
export function WaitingRoomIllustration({ className }: IllustrationProps) {
  return (
    <svg viewBox="0 0 200 150" className={className ?? 'size-44'} aria-hidden focusable="false">
      <rect x="46" y="20" width="108" height="62" rx="9" fill="currentColor" fillOpacity="0.06" />
      <rect
        x="46.5"
        y="20.5"
        width="107"
        height="61"
        rx="8.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.16"
      />
      {/* Countdown ring */}
      <circle
        cx="100"
        cy="51"
        r="17"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.14"
        strokeWidth="3"
      />
      <path
        d="M100 34a17 17 0 0 1 14.7 25.5"
        fill="none"
        stroke={ACCENT}
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* Seats */}
      {[
        [58, 108],
        [86, 116],
        [114, 116],
        [142, 108],
      ].map(([cx, cy]) => (
        <g key={`${cx}-${cy}`}>
          <circle cx={cx} cy={cy} r="9" fill="currentColor" fillOpacity="0.16" />
          <path
            d={`M${(cx ?? 0) - 12} ${(cy ?? 0) + 20}a12 12 0 0 1 24 0`}
            fill="currentColor"
            fillOpacity="0.1"
          />
        </g>
      ))}
    </svg>
  );
}

/** Invite screen: a link becoming two connected people. */
export function InviteIllustration({ className }: IllustrationProps) {
  return (
    <svg viewBox="0 0 200 150" className={className ?? 'size-40'} aria-hidden focusable="false">
      <circle cx="62" cy="75" r="24" fill={ACCENT} opacity="0.22" />
      <circle cx="138" cy="75" r="24" fill="var(--color-cyan-500)" opacity="0.2" />
      <path
        d="M84 75h32"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray="2 8"
      />
      <path
        d="M74 65a14 14 0 0 1 0 20M126 65a14 14 0 0 0 0 20"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.24"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 404: a scrub bar that ran off the end. */
export function NotFoundIllustration({ className }: IllustrationProps) {
  return (
    <svg viewBox="0 0 320 180" className={className ?? 'w-72'} aria-hidden focusable="false">
      <text
        x="160"
        y="104"
        textAnchor="middle"
        fontSize="86"
        fontWeight="700"
        fill="currentColor"
        fillOpacity="0.08"
        fontFamily="var(--font-sans)"
      >
        404
      </text>
      <rect x="48" y="130" width="224" height="5" rx="2.5" fill="currentColor" fillOpacity="0.12" />
      <rect x="48" y="130" width="224" height="5" rx="2.5" fill={ACCENT} opacity="0.55" />
      {/* The playhead has slipped past the end of the track */}
      <circle
        cx="292"
        cy="132.5"
        r="8"
        fill="var(--surface-base)"
        stroke={ACCENT}
        strokeWidth="2.5"
      />
      <path
        d="M282 148c4 6 12 8 18 4"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="2 4"
      />
    </svg>
  );
}

/** Indeterminate loader: three bars easing like an equaliser. */
export function LoadingIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 60 40" className={className ?? 'size-12'} role="status" aria-label="Loading">
      {[8, 25, 42].map((x, index) => (
        <rect
          key={x}
          x={x}
          y="10"
          width="10"
          height="20"
          rx="5"
          fill={ACCENT}
          opacity={0.9 - index * 0.2}
        >
          <animate
            attributeName="height"
            values="8;24;8"
            dur="1.1s"
            begin={`${index * 0.15}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="y"
            values="16;8;16"
            dur="1.1s"
            begin={`${index * 0.15}s`}
            repeatCount="indefinite"
          />
        </rect>
      ))}
    </svg>
  );
}

/** Feature-card glyphs. Same 48×48 grid so the cards align optically. */
export function FeatureGlyph({
  kind,
  className,
}: {
  kind: 'sync' | 'voice' | 'queue' | 'chat';
  className?: string;
}) {
  const common = {
    className: className ?? 'size-11',
    viewBox: '0 0 48 48',
    'aria-hidden': true,
  } as const;

  switch (kind) {
    case 'sync':
      return (
        <svg {...common}>
          <circle
            cx="24"
            cy="24"
            r="17"
            fill="none"
            stroke={ACCENT}
            strokeOpacity="0.25"
            strokeWidth="2.5"
          />
          <path
            d="M24 7a17 17 0 0 1 15 9"
            fill="none"
            stroke={ACCENT}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path
            d="M24 15v9l6 4"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.55"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'voice':
      return (
        <svg {...common}>
          <rect x="19" y="10" width="10" height="19" rx="5" fill={ACCENT} fillOpacity="0.85" />
          <path
            d="M13 25a11 11 0 0 0 22 0"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.5"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path
            d="M24 36v4"
            stroke="currentColor"
            strokeOpacity="0.5"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'queue':
      return (
        <svg {...common}>
          {[12, 21, 30].map((y, index) => (
            <rect
              key={y}
              x="9"
              y={y}
              width={30 - index * 6}
              height="5"
              rx="2.5"
              fill={ACCENT}
              fillOpacity={0.85 - index * 0.25}
            />
          ))}
          <circle
            cx="34"
            cy="34"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.45"
            strokeWidth="2.5"
          />
        </svg>
      );
    case 'chat':
      return (
        <svg {...common}>
          <path
            d="M10 16a6 6 0 0 1 6-6h16a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6H22l-8 6v-6h-4z"
            fill={ACCENT}
            fillOpacity="0.18"
            stroke={ACCENT}
            strokeOpacity="0.5"
            strokeWidth="2"
          />
          {[18, 24, 30].map((cx) => (
            <circle key={cx} cx={cx} cy="21" r="2" fill="currentColor" fillOpacity="0.55" />
          ))}
        </svg>
      );
  }
}
