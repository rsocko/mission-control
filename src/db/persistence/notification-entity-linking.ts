export interface NotificationEntityLinkingRepository {
  findTaskBySourceReference(input: {
    connectorInstanceId: string;
    repository: string;
    number: number;
  }): Promise<{ id: string } | null>;
  findProjectByRepository(repository: string): Promise<string | null>;
}

/**
 * ASCII-only case fold, matching SQLite's default (non-ICU) `LIKE`/`lower()`
 * behavior: only the 26 ASCII letters `A`-`Z` are folded to `a`-`z`; every
 * other character - including all non-ASCII/Unicode letters - is left
 * byte-for-byte unchanged. Deliberately **not** the same as PostgreSQL's
 * locale-aware `ILIKE`/`lower()`, which can fold non-ASCII case pairs (e.g.
 * Turkish "İ"/"i", German "ß") depending on the database's collation - using
 * `ILIKE` as a "case-insensitive" proxy would make suffix matching behave
 * differently per backend for non-ASCII input, which is exactly the parity
 * bug this function exists to close.
 *
 * `sqlite-notification-entity-linking-repository.ts`'s suffix match relies
 * on SQLite's own default `LIKE` (already exactly this fold, with no ICU
 * extension loaded) and is intentionally left as-is.
 * `postgres/repositories/notification-entity-linking-repository.ts` applies
 * this fold explicitly to its query parameter, paired with a `translate()`
 * expression that applies the identical `A`-`Z` -> `a`-`z` mapping to the
 * `source_id` column in SQL, so both backends fold exactly the same set of
 * characters and non-ASCII input is never folded on either backend.
 */
export function asciiFoldLower(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[i];
  }
  return out;
}

/** The literal `A`-`Z` character set `asciiFoldLower` folds, for reuse in SQL `translate()` expressions. */
export const ASCII_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** The literal `a`-`z` character set `asciiFoldLower` folds to, for reuse in SQL `translate()` expressions. */
export const ASCII_LOWER = 'abcdefghijklmnopqrstuvwxyz';
