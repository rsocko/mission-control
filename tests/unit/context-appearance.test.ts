import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_THEME_PREFERENCES,
  normalizeContextAppearance,
  normalizeContextThemePreferences,
  resolveContextAppearance,
} from '@/lib/context-appearance';

describe('context appearance', () => {
  it('uses distinct project and list defaults', () => {
    expect(resolveContextAppearance({ kind: 'project', accentColor: '#123456' })).toEqual({
      strength: 'frame',
      backdrop: 'none',
      accentColor: '#123456',
    });
    expect(resolveContextAppearance({ kind: 'list', accentColor: '#654321' })).toEqual({
      strength: 'atmosphere',
      backdrop: 'aurora',
      accentColor: '#654321',
    });
  });

  it('lets a context override strength, backdrop, and accent', () => {
    expect(resolveContextAppearance({
      kind: 'project',
      accentColor: '#123456',
      override: {
        strength: 'canvas',
        backdrop: 'ridge',
        accentColor: '#abcdef',
      },
    })).toEqual({
      strength: 'canvas',
      backdrop: 'ridge',
      accentColor: '#abcdef',
    });
  });

  it('suppresses backdrops for restrained strengths and global opt-out', () => {
    expect(resolveContextAppearance({
      kind: 'list',
      override: { strength: 'whisper', backdrop: 'nebula' },
    }).backdrop).toBe('none');

    expect(resolveContextAppearance({
      kind: 'list',
      override: { strength: 'canvas', backdrop: 'nebula' },
      preferences: { ...DEFAULT_CONTEXT_THEME_PREFERENCES, backdropsEnabled: false },
    }).backdrop).toBe('none');
  });

  it('rejects malformed stored values and fills partial preference records', () => {
    expect(normalizeContextAppearance({ strength: 'loud', backdrop: 'nebula' })).toBeNull();
    expect(normalizeContextThemePreferences({ projectStrength: 'whisper' })).toEqual({
      ...DEFAULT_CONTEXT_THEME_PREFERENCES,
      projectStrength: 'whisper',
    });
  });
});
