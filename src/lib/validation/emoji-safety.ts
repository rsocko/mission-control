/**
 * Emoji safety validation for Microsoft Graph API compatibility.
 * 
 * ROOT CAUSE: The Graph API /me/todo/lists endpoint silently excludes lists
 * whose displayName starts with a character in the Supplementary Multilingual
 * Plane (SMP, U+10000+). These require UTF-16 surrogate pairs, which the
 * Graph backend's list indexing appears to mishandle.
 * 
 * SAFE: BMP characters (U+0000–U+FFFF) — single UTF-16 code unit
 * UNSAFE: SMP characters (U+10000+) — surrogate pair in UTF-16
 * 
 * Examples:
 *   SAFE:   ✅ (U+2705), ⚡ (U+26A1), ⭐ (U+2B50), ⚙️ (U+2699)
 *   UNSAFE: 💯 (U+1F4AF), 📎 (U+1F4CE), 🔥 (U+1F525), 🏠 (U+1F3E0)
 */

const SMP_THRESHOLD = 0x10000;

/**
 * Check if a name starts with an unsafe SMP emoji that will be
 * invisible to the Microsoft Graph API listing endpoint.
 */
export function startsWithUnsafeEmoji(name: string): boolean {
  if (!name) return false;
  const cp = name.codePointAt(0) || 0;
  return cp >= SMP_THRESHOLD;
}

/**
 * Get the first character's codepoint for diagnostics.
 */
export function getFirstCodepoint(name: string): number {
  if (!name) return 0;
  return name.codePointAt(0) || 0;
}

/**
 * Returns a warning message if the name starts with an unsafe emoji,
 * or null if it's safe.
 */
export function validateNameForGraphApi(name: string): string | null {
  if (!startsWithUnsafeEmoji(name)) return null;

  const cp = getFirstCodepoint(name);
  const charLen = cp > 0xFFFF ? 2 : 1;
  const emoji = name.substring(0, charLen);

  return (
    `Name starts with "${emoji}" (U+${cp.toString(16).toUpperCase()}) which is in the ` +
    `Supplementary Multilingual Plane (SMP). Lists with SMP emoji prefixes are invisible ` +
    `to the Microsoft Graph API listing endpoint due to a UTF-16 surrogate pair bug. ` +
    `Use a BMP emoji (✅⚡⭐⚙️☀️❤️♻️ etc.) or no emoji prefix instead.`
  );
}
