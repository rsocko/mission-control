import type { CSSProperties, ReactNode } from 'react';
/** Supported icon source prefixes. Emoji values are stored without a prefix. */
export type IconSource = 'emoji' | 'lucide' | 'mdi' | 'ph' | 'dash' | 'si';
/** Parsed representation of a portable icon value. */
export interface ParsedIcon {
    source: IconSource;
    name: string;
}
export type IconPickerSize = 'sm' | 'md' | 'lg';
export type IconPickerTheme = 'auto' | 'light' | 'dark';
export type IconPickerCssVariable = '--rs-icon-picker-bg' | '--rs-icon-picker-surface' | '--rs-icon-picker-surface-hover' | '--rs-icon-picker-border' | '--rs-icon-picker-text' | '--rs-icon-picker-muted' | '--rs-icon-picker-accent' | '--rs-icon-picker-shadow' | '--rs-icon-picker-notice-bg' | '--rs-icon-picker-notice-text';
/** Inline styles, including the package's supported semantic custom properties. */
export type IconPickerStyle = CSSProperties & Partial<Record<IconPickerCssVariable, string | number>>;
export interface IconRendererProps {
    /** Raw emoji, a prefix:name value, or a legacy bare Lucide name. */
    value: string | null | undefined;
    /** Rendered size in CSS pixels. */
    size?: number;
    /** Optional hexadecimal color for providers that support tinting. */
    color?: string | undefined;
    className?: string;
    /** Accessible label. Pass an empty string for a decorative icon. */
    label?: string;
    /** Content shown for an empty, unsafe, or failed icon. */
    fallback?: ReactNode;
}
export interface IconPickerProps {
    value: string | null;
    onChange: (value: string) => void;
    onClose?: (() => void) | undefined;
    color?: string | undefined;
    onColorChange?: ((color: string) => void) | undefined;
    className?: string;
    id?: string;
    ariaLabel?: string;
    /** Search debounce in milliseconds. Primarily useful for custom UX tuning. */
    searchDebounceMs?: number;
    /** Enables modal dialog semantics and focus containment. */
    modal?: boolean;
    /** Theme behavior. Auto inherits the nearest host color-scheme. */
    theme?: IconPickerTheme;
    /** Root styles and namespaced semantic custom-property overrides. */
    style?: IconPickerStyle;
}
export interface IconPickerButtonProps {
    value: string | null;
    onChange: (value: string) => void;
    onOpenChange?: ((open: boolean) => void) | undefined;
    placeholder?: ReactNode;
    size?: IconPickerSize;
    className?: string;
    disabled?: boolean;
    color?: string | undefined;
    /** Picker color when the rendered trigger uses a resolved theme color. */
    pickerColor?: string | undefined;
    onColorChange?: ((color: string) => void) | undefined;
    /** Accessible name and tooltip for the trigger. */
    label?: string;
    /** Theme behavior for both the trigger and portal. */
    theme?: IconPickerTheme;
    /** Trigger styles. Semantic custom properties are propagated to the portal. */
    style?: IconPickerStyle;
    /** Optional portal host. Defaults to document.body in the browser. */
    portalTarget?: Element | null;
    /** Additional props passed to the picker panel. */
    pickerProps?: Omit<IconPickerProps, 'value' | 'onChange' | 'onClose' | 'color' | 'onColorChange' | 'id' | 'modal'>;
}
//# sourceMappingURL=types.d.ts.map