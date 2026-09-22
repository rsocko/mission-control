import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const quickAddSource = readFileSync(
  resolve(process.cwd(), 'src/components/add-task/QuickAddBar.tsx'),
  'utf8',
);
const globalStyles = readFileSync(
  resolve(process.cwd(), 'src/app/globals.css'),
  'utf8',
).replaceAll('\r\n', '\n');

describe('Quick Entry responsive layout', () => {
  it('keeps the primary entry row on one line and sizes it by its container', () => {
    expect(quickAddSource).toContain('quick-add-bar relative z-10');
    expect(quickAddSource).toContain('flex w-full min-w-0 items-center gap-2');
    expect(globalStyles).toContain('.quick-add-bar {\n  container-type: inline-size;');
  });

  it('progressively removes secondary controls before compacting the destination', () => {
    const projectBreakpoint = globalStyles.indexOf('@container (max-width: 34rem)');
    const voiceBreakpoint = globalStyles.indexOf('@container (max-width: 30rem)');
    const contextBreakpoint = globalStyles.indexOf('@container (max-width: 26rem)');
    const destinationBreakpoint = globalStyles.indexOf('@container (max-width: 22rem)');

    expect(projectBreakpoint).toBeGreaterThan(-1);
    expect(voiceBreakpoint).toBeGreaterThan(projectBreakpoint);
    expect(contextBreakpoint).toBeGreaterThan(voiceBreakpoint);
    expect(destinationBreakpoint).toBeGreaterThan(contextBreakpoint);
    expect(globalStyles).toContain('.quick-add-destination-label {\n    display: none;');
  });

  it('keeps hidden actions available from the overflow menu', () => {
    expect(quickAddSource).toContain("aria-label=\"More actions\"");
    expect(quickAddSource).toContain("myDayActive ? 'Remove from My Day' : 'Add to My Day'");
    expect(quickAddSource).toContain("contextProjectActive ? 'Remove from' : 'Add to'");
    expect(quickAddSource).toContain("isVoiceActive ? 'Stop dictation' : 'Dictate task'");
  });
});
