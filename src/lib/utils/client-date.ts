/**
 * Client-safe date utilities.
 * Uses local time (no Node.js dependencies, no UTC pitfalls).
 */

/**
 * Get today's date as YYYY-MM-DD in the browser's local timezone.
 * Unlike toISOString().split('T')[0], this won't shift to the next day
 * when local time is past midnight UTC.
 */
export function getLocalToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Get tomorrow's date as YYYY-MM-DD in the browser's local timezone.
 */
export function getLocalTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
