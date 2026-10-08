import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_ICON_PATHS,
  LOCAL_CONNECTOR_ICON_PATH,
  PAPERCLIP_CONNECTOR_ICON_PATH,
} from '@/lib/constants/colors';
import { CONNECTOR_ICONS as SETTINGS_CONNECTOR_ICONS } from '@/app/settings/components/types';
import {
  CONNECTOR_ICONS,
  NOTIFICATION_SOURCE_ICONS,
} from '@/types/dashboard';

describe('connector icon mappings', () => {
  it('uses the canonical Local connector icon for local tasks', () => {
    expect(CONNECTOR_ICON_PATHS.local).toBe(LOCAL_CONNECTOR_ICON_PATH);
    expect(CONNECTOR_ICONS.local).toBe(LOCAL_CONNECTOR_ICON_PATH);
  });

  it('uses the local Copilot icon for Scout', () => {
    expect(CONNECTOR_ICONS.scout).toBe('/icons/connectors/scout.svg');
  });

  it('uses the vendored official Paperclip logo across connector surfaces', () => {
    expect(CONNECTOR_ICON_PATHS.paperclip).toBe(PAPERCLIP_CONNECTOR_ICON_PATH);
    expect(CONNECTOR_ICONS.paperclip).toBe(PAPERCLIP_CONNECTOR_ICON_PATH);
    expect(SETTINGS_CONNECTOR_ICONS.paperclip).toBe(PAPERCLIP_CONNECTOR_ICON_PATH);
    expect(NOTIFICATION_SOURCE_ICONS.paperclip).toBe(PAPERCLIP_CONNECTOR_ICON_PATH);

    const icon = readFileSync(
      resolve(process.cwd(), 'public/icons/connectors/paperclip.svg'),
      'utf8',
    );
    expect(icon).toContain('viewBox="0 0 48 48"');
    expect(icon).toContain('<rect width="48" height="48" rx="10" fill="#0A0A0A"/>');
    expect(icon).toContain('stroke="#FFFFFF"');
    expect(icon).toContain('d="m16 6-8.414 8.586');
  });

  it('uses the Home Assistant logo across connector surfaces', () => {
    expect(CONNECTOR_ICON_PATHS['home-assistant']).toBe('/icons/connectors/home-assistant.svg');
    expect(CONNECTOR_ICONS['home-assistant']).toBe('/icons/connectors/home-assistant.svg');
    expect(SETTINGS_CONNECTOR_ICONS['home-assistant']).toBe('/icons/connectors/home-assistant.svg');
    expect(NOTIFICATION_SOURCE_ICONS['home-assistant']).toBe('/icons/connectors/home-assistant.svg');
    expect(readFileSync(
      resolve(process.cwd(), 'public/icons/connectors/home-assistant.svg'),
      'utf8',
    )).toContain('fill="#18bcf2"');
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
