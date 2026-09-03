import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAppMode = vi.fn();
const mockSetAppMode = vi.fn();
const mockGetSettings = vi.fn();
const mockUpdateSettings = vi.fn();
const mockIsPublicDemoMode = vi.fn();
const mockClearDatabase = vi.fn();
const mockResetDemoDatabase = vi.fn();
const mockClearTriageSampleData = vi.fn();
const mockApplyTimezoneRecompute = vi.fn();
const mockGetDemoSeedCommandService = vi.fn();
const mockGetRelativeReminderTimezoneRepository = vi.fn();

vi.mock('@/lib/mode', () => ({
  getAppMode: mockGetAppMode,
  setAppMode: mockSetAppMode,
  getSettings: mockGetSettings,
  updateSettings: mockUpdateSettings,
}));

vi.mock('@/lib/public-demo', () => ({
  isPublicDemoMode: mockIsPublicDemoMode,
}));

// The route depends only on the pure `@/lib/settings/mode-route-services`
// registry (see that module's doc comment) — it no longer imports
// `@/lib/seed-api`/`@/lib/triage/lifecycle` at all, statically or
// dynamically, so those modules are not mocked here.
vi.mock('@/lib/settings/mode-route-services', () => ({
  getDemoSeedCommandService: mockGetDemoSeedCommandService,
  getRelativeReminderTimezoneRepository: mockGetRelativeReminderTimezoneRepository,
}));

// `resolveRelativeReminderMutation` is intentionally NOT mocked — it's pure
// domain logic with its own dedicated unit tests (tests/unit/relative-reminder.test.ts).
// Exercising the real function here proves the route wires the repository's
// `recompute` callback correctly, without needing a real database.

import { GET, PATCH, POST } from '@/app/api/settings/mode/route';

const baseSettings = { mode: 'live' as const, timezone: 'America/New_York' };

describe('settings/mode route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPublicDemoMode.mockReturnValue(false);
    mockGetSettings.mockReturnValue({ ...baseSettings });
    mockGetAppMode.mockReturnValue('live');
    mockClearDatabase.mockResolvedValue(undefined);
    mockResetDemoDatabase.mockResolvedValue(undefined);
    mockClearTriageSampleData.mockResolvedValue(3);
    mockApplyTimezoneRecompute.mockResolvedValue({ invalidCount: 0 });
    mockGetDemoSeedCommandService.mockReturnValue({
      clearDatabase: mockClearDatabase,
      resetDemoDatabase: mockResetDemoDatabase,
      clearTriageSampleData: mockClearTriageSampleData,
    });
    mockGetRelativeReminderTimezoneRepository.mockReturnValue({
      applyTimezoneRecompute: mockApplyTimezoneRecompute,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('GET', () => {
    it('returns settings, mode, and publicDemo flag', async () => {
      mockIsPublicDemoMode.mockReturnValue(true);
      const response = await GET();
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ...baseSettings,
        mode: 'live',
        publicDemo: true,
      });
    });
  });

  describe('POST', () => {
    it('returns 403 in public demo mode without touching any action', async () => {
      mockIsPublicDemoMode.mockReturnValue(true);
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'live' }),
      });
      const response = await POST(request);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'Demo environment settings are managed by the deployment.',
      });
      expect(mockSetAppMode).not.toHaveBeenCalled();
    });

    it('handles reset-demo action', async () => {
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'POST',
        body: JSON.stringify({ action: 'reset-demo' }),
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(mockResetDemoDatabase).toHaveBeenCalledTimes(1);
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ demoSeededAt: expect.any(String) }),
      );
      await expect(response.json()).resolves.toEqual({
        success: true,
        message: 'Demo data reset successfully',
      });
    });

    it('handles clear-data action', async () => {
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'POST',
        body: JSON.stringify({ action: 'clear-data' }),
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(mockClearDatabase).toHaveBeenCalledTimes(1);
      await expect(response.json()).resolves.toEqual({
        success: true,
        message: 'All data cleared',
      });
    });

    it('handles clear-triage-samples action', async () => {
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'POST',
        body: JSON.stringify({ action: 'clear-triage-samples' }),
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(mockClearTriageSampleData).toHaveBeenCalledTimes(1);
      await expect(response.json()).resolves.toEqual({
        success: true,
        message: 'Cleared 3 triage sample item(s)',
      });
    });

    it('rejects an invalid mode with 400', async () => {
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'bogus' }),
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'mode must be "demo" or "live"',
      });
      expect(mockSetAppMode).not.toHaveBeenCalled();
    });

    it('switches demo -> live and clears demo data when requested', async () => {
      mockGetAppMode.mockReturnValue('demo');
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'live', clearDemoData: true }),
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(mockSetAppMode).toHaveBeenCalledWith('live');
      expect(mockClearDatabase).toHaveBeenCalledTimes(1);
      await expect(response.json()).resolves.toEqual({
        success: true,
        mode: 'live',
        previousMode: 'demo',
        message: 'Switched to live mode',
      });
    });

    it('switches live -> demo and seeds when not already seeded', async () => {
      mockGetAppMode.mockReturnValue('live');
      mockGetSettings.mockReturnValue({ ...baseSettings, demoSeededAt: undefined });
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'demo' }),
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(mockResetDemoDatabase).toHaveBeenCalledTimes(1);
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ demoSeededAt: expect.any(String) }),
      );
    });

    it('does not re-seed demo data when already seeded', async () => {
      mockGetAppMode.mockReturnValue('live');
      mockGetSettings.mockReturnValue({ ...baseSettings, demoSeededAt: '2026-01-01T00:00:00.000Z' });
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'demo' }),
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(mockResetDemoDatabase).not.toHaveBeenCalled();
    });

    it('skips seeding when seedIfEmpty is explicitly false', async () => {
      mockGetAppMode.mockReturnValue('live');
      mockGetSettings.mockReturnValue({ ...baseSettings, demoSeededAt: undefined });
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'demo', seedIfEmpty: false }),
      });
      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(mockResetDemoDatabase).not.toHaveBeenCalled();
    });
  });

  describe('PATCH', () => {
    it('returns 403 in public demo mode', async () => {
      mockIsPublicDemoMode.mockReturnValue(true);
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'PATCH',
        body: JSON.stringify({ timezone: 'America/New_York' }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(403);
      expect(mockGetRelativeReminderTimezoneRepository).not.toHaveBeenCalled();
    });

    it('rejects an invalid IANA timezone with 400', async () => {
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'PATCH',
        body: JSON.stringify({ timezone: 'Not/A_Zone' }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid timezone' });
      expect(mockGetRelativeReminderTimezoneRepository).not.toHaveBeenCalled();
    });

    it('is a no-op (skips the repository) when the timezone is unchanged', async () => {
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'PATCH',
        body: JSON.stringify({ timezone: baseSettings.timezone }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(200);
      expect(mockGetRelativeReminderTimezoneRepository).not.toHaveBeenCalled();
      expect(mockUpdateSettings).toHaveBeenCalledWith({ timezone: baseSettings.timezone });
    });

    it('resolves the repository, applies the update, and returns settings on success', async () => {
      mockApplyTimezoneRecompute.mockResolvedValue({ invalidCount: 0 });
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'PATCH',
        body: JSON.stringify({ timezone: 'Europe/London' }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(200);
      expect(mockGetRelativeReminderTimezoneRepository).toHaveBeenCalledTimes(1);
      expect(mockApplyTimezoneRecompute).toHaveBeenCalledWith(
        expect.objectContaining({ now: expect.any(Date), recompute: expect.any(Function) }),
      );
      expect(mockUpdateSettings).toHaveBeenCalledWith({ timezone: 'Europe/London' });
      await expect(response.json()).resolves.toEqual({ success: true, ...baseSettings });
    });

    it('returns 409 with no settings mutation when tasks would become invalid', async () => {
      mockApplyTimezoneRecompute.mockResolvedValue({ invalidCount: 2 });
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'PATCH',
        body: JSON.stringify({ timezone: 'Europe/London' }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: 'The timezone change would make one or more relative reminders invalid or past',
        code: 'RELATIVE_REMINDER_TIMEZONE_CONFLICT',
        affectedCount: 2,
      });
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it('passes each candidate task through the real relative-reminder recompute logic', async () => {
      // Wires the repository's `recompute` callback to the real
      // `resolveRelativeReminderMutation` (not mocked) — proves the route
      // does not reimplement or bypass that domain logic.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
      mockApplyTimezoneRecompute.mockImplementation(async ({ recompute }) => {
        const result = recompute({
          id: 'task-1',
          dueDate: '2026-07-28',
          reminderAt: '2026-07-27T12:00:00.000Z',
          reminderRelative: '1_day_before',
          reminderDueTime: '09:00',
        });
        expect(result).toEqual({
          success: true,
          updates: { reminderAt: '2026-07-27T08:00:00.000Z', reminderRelative: '1_day_before', reminderDueTime: '09:00' },
        });
        return { invalidCount: 0 };
      });
      const request = new Request('http://localhost/api/settings/mode', {
        method: 'PATCH',
        body: JSON.stringify({ timezone: 'Europe/London' }),
      });
      const response = await PATCH(request);
      expect(response.status).toBe(200);
      expect(mockApplyTimezoneRecompute).toHaveBeenCalledTimes(1);
    });
  });
});
