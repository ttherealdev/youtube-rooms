/**
 * The theme registry.
 *
 * Keys must stay in step with three other places, or a theme silently fails to
 * apply: `THEMES` in apps/server/src/rooms/themes.rs (which validates what a
 * host may store), the selectors in src/styles/themes.css (which define the
 * palettes), and the `data-theme` attribute written by ThemeProvider.
 *
 * The swatches are for the picker only. They are plain colour strings rather
 * than reads of the live CSS variables, because the picker shows every theme at
 * once and only one of them is applied to the document at a time.
 */

export const THEME_KEYS = [
  'default',
  'amethyst',
  'amber',
  'bubblegum',
  'caffeine',
  'claymorphism',
  'cosmic',
  'graphite',
  'mono',
  'nature',
  'ocean',
  'sunset',
] as const;

export type ThemeKey = (typeof THEME_KEYS)[number];
export type ThemeMode = 'light' | 'dark';

export interface ThemeMeta {
  key: ThemeKey;
  label: string;
  description: string;
  /** [background, surface, primary] for the light preview. */
  light: [string, string, string];
  /** Same three, for dark. */
  dark: [string, string, string];
}

export const THEMES: ThemeMeta[] = [
  {
    key: 'default',
    label: 'Default',
    description: 'High-contrast neutral',
    light: ['oklch(0.99 0 0)', 'oklch(1 0 0)', 'oklch(0 0 0)'],
    dark: ['oklch(0 0 0)', 'oklch(0.14 0 0)', 'oklch(1 0 0)'],
  },
  {
    key: 'amethyst',
    label: 'Amethyst',
    description: 'Deep violet',
    light: ['oklch(0.98 0.005 300)', 'oklch(1 0 0)', 'oklch(0.54 0.22 295)'],
    dark: ['oklch(0.16 0.02 295)', 'oklch(0.20 0.026 295)', 'oklch(0.72 0.17 296)'],
  },
  {
    key: 'amber',
    label: 'Amber',
    description: 'Warm and golden',
    light: ['oklch(0.99 0.008 85)', 'oklch(1 0 0)', 'oklch(0.70 0.17 62)'],
    dark: ['oklch(0.15 0.012 70)', 'oklch(0.19 0.016 70)', 'oklch(0.78 0.16 68)'],
  },
  {
    key: 'bubblegum',
    label: 'Bubblegum',
    description: 'Pink and rounded',
    light: ['oklch(0.985 0.012 350)', 'oklch(1 0 0)', 'oklch(0.64 0.22 350)'],
    dark: ['oklch(0.17 0.025 340)', 'oklch(0.21 0.032 340)', 'oklch(0.76 0.16 348)'],
  },
  {
    key: 'caffeine',
    label: 'Caffeine',
    description: 'Coffee and cream',
    light: ['oklch(0.975 0.01 70)', 'oklch(0.995 0.005 70)', 'oklch(0.43 0.09 45)'],
    dark: ['oklch(0.16 0.012 50)', 'oklch(0.20 0.016 50)', 'oklch(0.74 0.10 62)'],
  },
  {
    key: 'claymorphism',
    label: 'Clay',
    description: 'Soft shadows, big radius',
    light: ['oklch(0.955 0.01 265)', 'oklch(0.985 0.005 265)', 'oklch(0.59 0.16 265)'],
    dark: ['oklch(0.18 0.018 265)', 'oklch(0.23 0.022 265)', 'oklch(0.72 0.14 266)'],
  },
  {
    key: 'cosmic',
    label: 'Cosmic',
    description: 'Indigo and electric',
    light: ['oklch(0.975 0.008 280)', 'oklch(1 0 0)', 'oklch(0.51 0.24 275)'],
    dark: ['oklch(0.12 0.028 280)', 'oklch(0.17 0.034 280)', 'oklch(0.70 0.19 285)'],
  },
  {
    key: 'graphite',
    label: 'Graphite',
    description: 'Cool grey, tight corners',
    light: ['oklch(0.965 0.002 250)', 'oklch(0.99 0.001 250)', 'oklch(0.36 0.015 250)'],
    dark: ['oklch(0.175 0.004 250)', 'oklch(0.215 0.005 250)', 'oklch(0.84 0.01 250)'],
  },
  {
    key: 'mono',
    label: 'Mono',
    description: 'Monospaced, square, flat',
    light: ['oklch(0.99 0 0)', 'oklch(1 0 0)', 'oklch(0 0 0)'],
    dark: ['oklch(0.12 0 0)', 'oklch(0.16 0 0)', 'oklch(1 0 0)'],
  },
  {
    key: 'nature',
    label: 'Nature',
    description: 'Forest green',
    light: ['oklch(0.98 0.01 140)', 'oklch(1 0 0)', 'oklch(0.52 0.13 150)'],
    dark: ['oklch(0.15 0.018 150)', 'oklch(0.19 0.022 150)', 'oklch(0.74 0.15 148)'],
  },
  {
    key: 'ocean',
    label: 'Ocean',
    description: 'Deep blue',
    light: ['oklch(0.98 0.01 220)', 'oklch(1 0 0)', 'oklch(0.55 0.15 230)'],
    dark: ['oklch(0.14 0.022 230)', 'oklch(0.185 0.026 230)', 'oklch(0.73 0.14 225)'],
  },
  {
    key: 'sunset',
    label: 'Sunset',
    description: 'Burnt orange',
    light: ['oklch(0.982 0.012 40)', 'oklch(1 0 0)', 'oklch(0.62 0.21 25)'],
    dark: ['oklch(0.155 0.024 30)', 'oklch(0.195 0.03 30)', 'oklch(0.73 0.17 38)'],
  },
];

export const DEFAULT_THEME: ThemeKey = 'default';
export const DEFAULT_MODE: ThemeMode = 'dark';

/**
 * Narrow an untrusted string to a known theme.
 *
 * Room themes arrive over the socket and land in a `data-theme` attribute, so
 * an unrecognised value falls back rather than being written through. The
 * server validates too; this is the second line, not the only one.
 */
export function asThemeKey(value: string | null | undefined): ThemeKey {
  return THEME_KEYS.includes(value as ThemeKey) ? (value as ThemeKey) : DEFAULT_THEME;
}

export function asThemeMode(value: string | null | undefined): ThemeMode {
  return value === 'light' || value === 'dark' ? value : DEFAULT_MODE;
}

/** localStorage keys. Read by the pre-paint bootstrap script in the layout. */
export const THEME_STORAGE_KEY = 'playercn-theme';
export const MODE_STORAGE_KEY = 'playercn-mode';
