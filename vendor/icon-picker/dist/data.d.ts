import type { IconSource } from './types';
export interface SourceFilter {
    id: IconSource;
    label: string;
    iconifyPrefix?: 'lucide' | 'mdi' | 'ph';
}
export declare const SOURCE_FILTERS: readonly SourceFilter[];
export declare const ICON_COLORS: readonly ["#ffffff", "#94a3b8", "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#ef4444", "#f97316"];
export declare const POPULAR_EMOJI: string[];
export declare const POPULAR_LUCIDE: string[];
export declare const POPULAR_MDI: string[];
export declare const POPULAR_PHOSPHOR: string[];
export declare const POPULAR_DASHBOARD_ICONS: string[];
export declare const POPULAR_SIMPLE_ICONS: string[];
export declare const POPULAR_BY_SOURCE: Record<Exclude<IconSource, 'emoji'>, readonly string[]>;
//# sourceMappingURL=data.d.ts.map