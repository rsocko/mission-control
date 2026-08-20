import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  classifyNotifications,
  computeSmartPriority,
  getEnergyTagsForTasks,
  normalizeNotificationClassifications,
  triageAlerts,
  triageNotifications,
} from '@/lib/ai';
import { computeSmartPriority as featureComputeSmartPriority } from '@/lib/ai/features/smart-priority';
import { getEnergyTagsForTasks as queryGetEnergyTagsForTasks } from '@/lib/ai/features/energy-tag-queries';
import {
  classifyNotifications as featureClassifyNotifications,
  normalizeNotificationClassifications as featureNormalizeNotificationClassifications,
} from '@/lib/ai/features/notification-classification';

describe('AI public API compatibility', () => {
  it('keeps existing public exports while exposing collision-free notification naming', () => {
    expect(computeSmartPriority).toBe(featureComputeSmartPriority);
    expect(getEnergyTagsForTasks).toBe(queryGetEnergyTagsForTasks);
    expect(classifyNotifications).toBe(featureClassifyNotifications);
    expect(triageNotifications).toBe(classifyNotifications);
    expect(triageAlerts).toBe(classifyNotifications);
    expect(normalizeNotificationClassifications)
      .toBe(featureNormalizeNotificationClassifications);
  });

  it('keeps the AI index implementation-free', async () => {
    const source = await readFile(
      new URL('../../src/lib/ai/index.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toMatch(/\b(?:async )?function\b/);
    expect(source).not.toMatch(/\b(?:const|let|var)\b/);
    expect(source).not.toContain("from 'ai'");
    expect(source).not.toContain("from '@/db'");
  });

  it('keeps query-only energy imports independent from AI workflows', async () => {
    const source = await readFile(
      new URL('../../src/lib/ai/features/energy-tag-queries.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain("from 'ai'");
    expect(source).not.toContain('energy-tag-suggestions');
  });
});
