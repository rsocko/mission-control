import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SHORTCUT_PAGES } from '@/lib/navigation/shortcut-catalog';

const NAV_COLOR_HEX: Record<string, string> = {
  'text-blue-400': '#60a5fa',
  'text-amber-400': '#fbbf24',
  'text-violet-400': '#a78bfa',
  'text-cyan-400': '#22d3ee',
  'text-rose-400': '#fb7185',
  'text-sky-400': '#38bdf8',
  'text-yellow-400': '#facc15',
  'text-emerald-400': '#34d399',
  'text-purple-400': '#c084fc',
  'text-pink-400': '#f472b6',
  'text-indigo-400': '#818cf8',
  'text-slate-400': '#94a3b8',
};

describe('shortcut catalog', () => {
  it('provides an icon asset using the matching navigation color for every page', () => {
    for (const page of SHORTCUT_PAGES) {
      const iconPath = path.join(process.cwd(), 'public', 'icons', page.icon);
      const icon = fs.readFileSync(iconPath, 'utf8');
      const expectedColor = NAV_COLOR_HEX[page.iconColor];

      expect(expectedColor, `missing color mapping for ${page.name}`).toBeDefined();
      if (page.iconKey !== 'houston') {
        expect(icon.toLowerCase(), page.name).toContain(`fill="${expectedColor}"`);
      }
    }
  });
});
