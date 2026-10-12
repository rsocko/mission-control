import type { IconSource } from './types';
export interface IconCategory {
    name: string;
    icons: string[];
}
export interface IconCatalog {
    icons: string[];
    categories: IconCategory[];
}
type IconifyCatalogSource = Extract<IconSource, 'lucide' | 'mdi' | 'ph' | 'si'>;
export declare function parseIconifyCatalog(data: unknown): IconCatalog | null;
export declare function fetchIconifyCatalog(source: IconifyCatalogSource, signal: AbortSignal): Promise<IconCatalog>;
export declare function fetchDashboardCatalog(signal: AbortSignal): Promise<IconCatalog>;
export {};
//# sourceMappingURL=catalogs.d.ts.map