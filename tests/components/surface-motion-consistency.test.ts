import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  drawerOverlay,
  drawerSlideIn,
  modalContent,
  modalOverlay,
  panelSlideFromRight,
  surfaceExitTransition,
} from '@/lib/motion';

describe('surface motion consistency', () => {
  it('uses one 200ms ease-out transition for close animations', () => {
    expect(surfaceExitTransition).toEqual({
      type: 'tween',
      duration: 0.2,
      ease: 'easeOut',
    });

    for (const variants of [
      modalOverlay,
      modalContent,
      drawerOverlay,
      drawerSlideIn,
      panelSlideFromRight,
    ]) {
      expect(variants.exit).toMatchObject({
        transition: surfaceExitTransition,
      });
    }
  });

  it('pairs modal backdrop fade with content scale', () => {
    expect(modalOverlay.exit).toMatchObject({ opacity: 0 });
    expect(modalContent.exit).toMatchObject({ opacity: 0, scale: 0.97 });
  });

  it('keeps legacy closeable surfaces on the shared modal motion', () => {
    const autoTriage = readFileSync(
      resolve(process.cwd(), 'src/components/triage/AutoTriageModal.tsx'),
      'utf8',
    );
    const todaySchedule = readFileSync(
      resolve(process.cwd(), 'src/components/today/TodayScheduleModal.tsx'),
      'utf8',
    );
    const taskMove = readFileSync(
      resolve(process.cwd(), 'src/components/task-detail/TaskMoveDialog.tsx'),
      'utf8',
    );
    const taskNotes = readFileSync(
      resolve(process.cwd(), 'src/components/task-detail/TaskNotesDialog.tsx'),
      'utf8',
    );

    expect(autoTriage).toContain('<Modal');
    expect(todaySchedule).toContain('<Modal');
    expect(taskMove).toContain('variants={modalOverlay}');
    expect(taskMove).toContain('variants={modalContent}');
    expect(taskNotes).toContain('variants={modalOverlay}');
    expect(taskNotes).toContain('variants={modalContent}');
  });
});
