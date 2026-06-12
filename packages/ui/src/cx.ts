/**
 * Joins truthy class-name fragments with a single space.
 *
 * Tiny local alternative to `clsx` so the package stays dependency-free.
 */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
