/**
 * Job deduplication.
 *
 * The naive approach — comparing full job URLs — fails silently: Adzuna
 * appends a per-request tracking token to the query string on every API
 * call for the *same* underlying job ad, while the path contains the
 * stable ad ID. Comparing full URLs treats the same job as "new" every
 * time a different search query happens to surface it, producing
 * duplicate rows for identical postings.
 *
 * The fix: normalize to origin + pathname for comparison purposes only,
 * while still storing the original full URL on the record for click-through.
 */
function normalizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw;
  }
}

/**
 * Filters a batch of newly-fetched job postings down to ones not already
 * present, using normalized-URL identity rather than raw string equality.
 * Also guards against duplicates *within* the same fetch batch (e.g. the
 * same posting surfacing under two different search queries in one run).
 */
export function dedupeJobs<T extends { url?: string | null }>(
  incoming: T[],
  existingUrls: Iterable<string>
): T[] {
  const existing = new Set(Array.from(existingUrls, normalizeUrl));
  const seenInThisBatch = new Set<string>();
  const result: T[] = [];

  for (const job of incoming) {
    if (!job.url) continue;
    const key = normalizeUrl(job.url);
    if (existing.has(key) || seenInThisBatch.has(key)) continue;
    seenInThisBatch.add(key);
    result.push(job);
  }

  return result;
}
