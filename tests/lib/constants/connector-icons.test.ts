import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_ICON_PATHS,
  LOCAL_CONNECTOR_ICON_PATH,
} from '@/lib/constants/colors';
import { CONNECTOR_ICONS } from '@/types/dashboard';

describe('connector icon mappings', () => {
  it('uses the canonical Local connector icon for local tasks', () => {
    expect(CONNECTOR_ICON_PATHS.local).toBe(LOCAL_CONNECTOR_ICON_PATH);
    expect(CONNECTOR_ICONS.local).toBe(LOCAL_CONNECTOR_ICON_PATH);
  });

  it.each(['finance-manager', 'monarch-money'])(
    'uses the Tyrion connector icon for %s surfaces',
    (connectorType) => {
      expect(CONNECTOR_ICON_PATHS[connectorType]).toBe('/icons/connectors/tyrion.svg');
      expect(CONNECTOR_ICONS[connectorType]).toBe('/icons/connectors/tyrion.svg');
    },
  );

  it('uses the optically cropped Stored Signal artwork', () => {
    const icon = readFileSync(
      resolve(process.cwd(), 'public/icons/connectors/local.svg'),
      'utf8',
    );

    expect(icon).toContain('viewBox="2 2 20 20"');
    expect(icon).toContain('stroke="#3b82f6"');
    expect(icon).toContain('stroke="#22d3ee"');
    expect(icon).not.toContain('<rect');
  });
});
