import { describe, expect, it } from 'vitest';
import { calendarClassNames } from '@/components/ui/calendar-classes';

describe('calendarClassNames', () => {
  it('keeps month navigation aligned with the caption', () => {
    expect(calendarClassNames.root).toContain('relative');
    expect(calendarClassNames.month_caption).toContain('h-7');
    expect(calendarClassNames.nav).toContain('absolute');
    expect(calendarClassNames.nav).toContain('top-3');
    expect(calendarClassNames.nav).toContain('right-3');
  });

  it('styles navigation chevrons using the button color', () => {
    expect(calendarClassNames.chevron).toContain('size-4');
    expect(calendarClassNames.chevron).toContain('fill-current');
    expect(calendarClassNames.button_previous).toContain('focus-visible:ring-2');
    expect(calendarClassNames.button_next).toContain('focus-visible:ring-2');
  });
});
