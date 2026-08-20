/**
 * Slug helpers. Pure functions, no I/O — uniqueness is the caller's problem.
 */

const MAX_SLUG_LENGTH = 40;

/** Converts arbitrary text into a URL-safe kebab-case slug. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * Appends a numeric suffix until the slug is not taken.
 * `isTaken` is injected so this stays pure and unit-testable.
 */
export async function uniqueSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const root = slugify(base) || 'org';

  if (!(await isTaken(root))) return root;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${root.slice(0, MAX_SLUG_LENGTH - tail.length)}${tail}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  throw new Error(`Unable to derive a unique slug from "${base}" after 1000 attempts.`);
}
