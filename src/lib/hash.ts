/**
 * Deterministic content hashing.
 *
 * Used to decide whether a Google profile actually changed between syncs. This
 * only works if serialization is stable: `JSON.stringify` preserves insertion
 * order, and Google does not guarantee field order, so an unsorted hash would
 * report spurious changes and fill the snapshot table with duplicates.
 */

import { createHash } from 'node:crypto';

/** JSON serialization with object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Array order is meaningful (hours periods, categories) — preserved.
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

/** SHA-256 of the stable serialization, hex encoded. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
