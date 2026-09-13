import { z } from 'zod';
import type {
  ContextAppearance,
  ContextThemeBackdrop,
  ContextThemePreferences,
  ContextThemeStrength,
} from '@/types';

export const CONTEXT_THEME_STRENGTHS = [
  'whisper',
  'frame',
  'atmosphere',
  'canvas',
] as const satisfies readonly ContextThemeStrength[];

export const CONTEXT_THEME_BACKDROPS = [
  'none',
  'aurora',
  'ridge',
  'nebula',
] as const satisfies readonly ContextThemeBackdrop[];

export const contextAppearanceSchema = z.object({
  strength: z.enum(CONTEXT_THEME_STRENGTHS),
  backdrop: z.enum(CONTEXT_THEME_BACKDROPS),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).strict();

export const contextThemePreferencesSchema = z.object({
  projectStrength: z.enum(CONTEXT_THEME_STRENGTHS),
  listStrength: z.enum(CONTEXT_THEME_STRENGTHS),
  defaultBackdrop: z.enum(CONTEXT_THEME_BACKDROPS),
  backdropsEnabled: z.boolean(),
}).strict();

export const DEFAULT_CONTEXT_THEME_PREFERENCES: ContextThemePreferences = {
  projectStrength: 'frame',
  listStrength: 'atmosphere',
  defaultBackdrop: 'aurora',
  backdropsEnabled: true,
};

export function normalizeContextAppearance(value: unknown): ContextAppearance | null {
  if (value === null || value === undefined) return null;
  const parsed = contextAppearanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function normalizeContextThemePreferences(value: unknown): ContextThemePreferences {
  const parsed = contextThemePreferencesSchema.partial().safeParse(value);
  return parsed.success
    ? { ...DEFAULT_CONTEXT_THEME_PREFERENCES, ...parsed.data }
    : DEFAULT_CONTEXT_THEME_PREFERENCES;
}

export function resolveContextAppearance(input: {
  kind: 'project' | 'list';
  accentColor?: string | null;
  override?: ContextAppearance | null;
  preferences?: ContextThemePreferences;
}): ContextAppearance {
  const preferences = input.preferences ?? DEFAULT_CONTEXT_THEME_PREFERENCES;
  const override = normalizeContextAppearance(input.override);
  const strength = override?.strength
    ?? (input.kind === 'project' ? preferences.projectStrength : preferences.listStrength);
  const backdrop = preferences.backdropsEnabled
    ? (override?.backdrop ?? preferences.defaultBackdrop)
    : 'none';
  return {
    strength,
    backdrop: strength === 'whisper' || strength === 'frame' ? 'none' : backdrop,
    accentColor: override?.accentColor ?? input.accentColor ?? '#3b82f6',
  };
}
