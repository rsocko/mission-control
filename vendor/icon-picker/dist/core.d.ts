export type { IconSource, ParsedIcon } from './types';
import type { ParsedIcon } from './types';
/** Parse a stored icon string into a source and provider-specific name. */
export declare function parseIconValue(value: string | null | undefined): ParsedIcon | null;
/** Serialize a parsed icon to the portable storage contract. */
export declare function serializeIconValue(icon: ParsedIcon): string;
/** Normalize current and legacy Simple Icons catalog response shapes. */
export declare function getSimpleIconNames(data: unknown): string[];
/** Return a provider URL for an icon, or null for emoji and unsafe names. */
export declare function getIconUrl(icon: ParsedIcon, color?: string): string | null;
//# sourceMappingURL=core.d.ts.map