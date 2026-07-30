/**
 * Initials from a display name, for the generated avatar.
 *
 * Mirrors `util::initials` on the server so an optimistic client-side preview
 * matches exactly what the server will send back. If these two ever disagree,
 * a user's avatar visibly changes the moment their first message lands.
 */
export function initialsOf(displayName: string): string {
  const tokens = displayName.split(/\s+/).filter((token) => /\p{L}|\p{N}/u.test(token));

  const firstAlnum = (token: string): string | undefined => {
    const match = token.match(/\p{L}|\p{N}/u);
    return match?.[0]?.toUpperCase();
  };

  if (tokens.length === 0) return '?';
  if (tokens.length === 1) return firstAlnum(tokens[0] ?? '') ?? '?';

  const first = firstAlnum(tokens[0] ?? '') ?? '';
  const last = firstAlnum(tokens[tokens.length - 1] ?? '') ?? '';
  return `${first}${last}` || '?';
}
