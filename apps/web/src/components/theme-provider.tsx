import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  asThemeKey,
  asThemeMode,
  DEFAULT_MODE,
  DEFAULT_THEME,
  MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type ThemeKey,
  type ThemeMode,
} from '~/lib/themes';

/**
 * Theme state, on two independent axes.
 *
 * There are two *sources* of a theme and they do not have equal standing:
 *
 *   * The **personal** preference, chosen in the customizer and persisted
 *     locally. It follows the user everywhere.
 *   * The **room** theme, set by that room's host and pushed over the socket to
 *     everyone in it. It wins while you are in that room, and only there.
 *
 * Keeping the personal choice intact underneath — rather than overwriting it
 * when a room imposes its own — is what makes leaving a room restore your own
 * theme instead of stranding you in the host's.
 */

interface ThemeContextValue {
  /** What is actually on screen right now. */
  theme: ThemeKey;
  mode: ThemeMode;
  /** The user's own preference, ignoring any room override. */
  preferredTheme: ThemeKey;
  preferredMode: ThemeMode;
  /** True while a room is overriding the personal choice. */
  overridden: boolean;
  setTheme: (theme: ThemeKey) => void;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
  /** Push a room's theme, or `null` to hand control back to the user. */
  setRoomTheme: (theme: ThemeKey | null, mode: ThemeMode | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

/**
 * Runs before first paint, from the document head.
 *
 * Without this the server-rendered HTML carries the default theme and the
 * browser repaints to the stored one after hydration — a flash of the wrong
 * colours on every single page load. It is inline and synchronous for exactly
 * that reason.
 */
export const themeBootstrapScript = `
(function(){
  try {
    var t = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}) || ${JSON.stringify(DEFAULT_THEME)};
    var m = localStorage.getItem(${JSON.stringify(MODE_STORAGE_KEY)}) || ${JSON.stringify(DEFAULT_MODE)};
    var r = document.documentElement;
    r.dataset.theme = t;
    r.classList.toggle('dark', m === 'dark');
    r.style.colorScheme = m;
  } catch (e) {
    /* Private mode blocks localStorage; the default theme is already correct. */
  }
})();
`;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Seeded with the defaults so the server render and the first client render
  // agree. The real values are adopted in the effect below, which runs after
  // the bootstrap script has already put them on screen — so this reconciles
  // React's idea of the world with the DOM, and never causes a repaint.
  const [preferredTheme, setPreferredTheme] = useState<ThemeKey>(DEFAULT_THEME);
  const [preferredMode, setPreferredMode] = useState<ThemeMode>(DEFAULT_MODE);
  const [roomTheme, setRoomThemeState] = useState<ThemeKey | null>(null);
  const [roomMode, setRoomModeState] = useState<ThemeMode | null>(null);

  useEffect(() => {
    try {
      setPreferredTheme(asThemeKey(localStorage.getItem(THEME_STORAGE_KEY)));
      setPreferredMode(asThemeMode(localStorage.getItem(MODE_STORAGE_KEY)));
    } catch {
      // Storage unavailable; the defaults already applied are fine.
    }
  }, []);

  const theme = roomTheme ?? preferredTheme;
  const mode = roomMode ?? preferredMode;

  useEffect(() => {
    const root = document.documentElement;

    // Suppress transitions for one frame so the swap reads as a switch rather
    // than every element smearing to its new colour on its own schedule.
    root.classList.add('theme-transition');

    root.dataset.theme = theme;
    root.classList.toggle('dark', mode === 'dark');
    root.style.colorScheme = mode;

    const frame = requestAnimationFrame(() => {
      root.classList.remove('theme-transition');
    });
    return () => cancelAnimationFrame(frame);
  }, [theme, mode]);

  const setTheme = useCallback((next: ThemeKey) => {
    setPreferredTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Not persisting is survivable; not applying would not be.
    }
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setPreferredMode(next);
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // As above.
    }
  }, []);

  const toggleMode = useCallback(() => {
    setMode(mode === 'dark' ? 'light' : 'dark');
  }, [mode, setMode]);

  const setRoomTheme = useCallback((next: ThemeKey | null, nextMode: ThemeMode | null) => {
    setRoomThemeState(next);
    setRoomModeState(nextMode);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      mode,
      preferredTheme,
      preferredMode,
      overridden: roomTheme !== null,
      setTheme,
      setMode,
      toggleMode,
      setRoomTheme,
    }),
    [
      theme,
      mode,
      preferredTheme,
      preferredMode,
      roomTheme,
      setTheme,
      setMode,
      toggleMode,
      setRoomTheme,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
