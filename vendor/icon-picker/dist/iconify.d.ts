import type { IconSource } from './types';
export declare function iconMaskCacheKey(source: IconSource, name: string): string;
export declare function loadIconifyMasks(source: IconSource, names: string[], signal?: AbortSignal): Promise<Record<string, string | null>>;
//# sourceMappingURL=iconify.d.ts.map