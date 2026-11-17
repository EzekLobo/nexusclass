/** Match the official task identity, never a title or a student's check URL. */
export function correctionTaskKey(raw?: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "learn.kodland.org" || url.username || url.password) return null;
    const match = url.pathname.match(/^\/[a-z]{2}\/task\/(\d+)\/(?:check\/[^/]+|teacher\/do)\/?$/);
    return match ? `kodland:${match[1]}` : null;
  } catch { return null; }
}
