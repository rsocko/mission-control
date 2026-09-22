import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readSource(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function collectTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? collectTsxFiles(path)
      : extname(entry.name) === '.tsx'
        ? [path]
        : [];
  });
}

const compositeControlSources = [
  ['src/app/icons/page.tsx', 1],
  ['src/app/projects/[id]/PhaseAssignView.tsx', 1],
  ['src/app/projects/[id]/tabs/ProjectPhasesTab.tsx', 1],
  ['src/app/settings/components/GeneralSettingsSection.tsx', 1],
  ['src/components/add-task/DestinationPicker.tsx', 1],
  ['src/components/add-task/SaveTemplateModal.tsx', 1],
  ['src/components/add-task/TemplatePicker.tsx', 1],
  ['src/components/bulk-actions/BulkMoveDropdown.tsx', 1],
  ['src/components/bulk-actions/BulkMoveToSourceButton.tsx', 1],
  ['src/components/bulk-actions/BulkTagDropdown.tsx', 1],
  ['src/components/layout/MobileDrawer.tsx', 1],
  ['src/components/mobile/MobileSearchScreen.tsx', 1],
  ['src/components/projects/TaskPickerDialog.tsx', 1],
  ['src/components/quick-sort/QuickSortActions.tsx', 1],
  ['src/components/quick-sort/ScopeFilter.tsx', 1],
  ['src/components/reset/ResetView.tsx', 2],
  ['src/components/search/SearchCommand.tsx', 1],
  ['src/components/task-detail/MoveToListDropdown.tsx', 1],
  ['src/components/task-detail/TagPickerPopover.tsx', 1],
  ['src/components/task-detail/TaskMoveDialog.tsx', 1],
  ['src/components/task-detail/TaskTagsSection.tsx', 1],
  ['src/components/task-list/TaskContextMenu.tsx', 1],
  ['src/components/ui/icon-picker/IconPicker.tsx', 1],
] as const;

describe('text-entry focus glow policy', () => {
  it('moves the focus glow from embedded fields to their visual wrapper', () => {
    const globalsCss = readSource('src/app/globals.css');

    expect(globalsCss).toMatch(
      /\.input-glow:focus-within\s*\{[\s\S]*?box-shadow:\s*var\(--shadow-focus-glow\)/,
    );
    expect(globalsCss).toMatch(
      /\.input-glow :where\([\s\S]*?\):focus\s*\{[\s\S]*?box-shadow:\s*none/,
    );
  });

  it.each(compositeControlSources)('marks every composite control in %s', (path, expectedCount) => {
    expect(readSource(path).match(/\binput-glow\b/g)).toHaveLength(expectedCount);
  });

  it('keeps unrelated search-command and reward actions outside the glow boundary', () => {
    const searchCommand = readSource('src/components/search/SearchCommand.tsx');
    const rewards = readSource('src/app/settings/components/GeneralSettingsSection.tsx');

    expect(searchCommand).toContain(
      '<div className="input-glow flex items-center gap-3 rounded-[var(--radius-md)]">',
    );
    expect(searchCommand).toContain(
      '<div className="mt-2.5 flex flex-wrap items-center gap-1.5">',
    );
    expect(rewards).toContain("editingReward === reward.id ? 'input-glow' : ''");
  });

  it('does not stack legacy focus rings on text-entry controls', () => {
    const violations = collectTsxFiles(resolve(root, 'src'))
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return [...source.matchAll(/<(?:input|textarea)\b[\s\S]*?\/>/g)]
          .filter((match) => /focus(?:-visible)?:ring/.test(match[0]))
          .filter((match) => {
            const type = match[0].match(/\btype=["']([^"']+)["']/)?.[1];
            return !type || ['text', 'search', 'email', 'password', 'url', 'tel', 'number'].includes(type);
          })
          .map(() => relative(root, path));
      });

    expect(violations).toEqual([]);
  });
});
