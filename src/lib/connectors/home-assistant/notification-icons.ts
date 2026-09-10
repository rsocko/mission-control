const BRAND_IMAGE_PATH = /^\/api\/brands\/integration\/([a-z0-9_]+)\/((?:dark_)?icon(?:@2x)?\.png)$/;
const SUPERVISOR_ADDON_IMAGE_PATH = /^\/api\/hassio\/addons\/[a-z0-9_-]+\/icon$/;
const PUBLIC_BRANDS_HOST = 'brands.home-assistant.io';
const MDI_ICON = /^mdi:[a-z0-9][a-z0-9-]*$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeHomeAssistantImagePath(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value, 'https://home-assistant.invalid');
  } catch {
    return null;
  }

  if (url.origin === 'https://home-assistant.invalid') {
    return BRAND_IMAGE_PATH.test(url.pathname)
      || SUPERVISOR_ADDON_IMAGE_PATH.test(url.pathname)
      ? url.pathname
      : null;
  }
  if (url.protocol !== 'https:' || url.hostname !== PUBLIC_BRANDS_HOST) {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const domainIndex = segments[0] === '_' ? 1 : 0;
  const domain = segments[domainIndex];
  const image = segments[domainIndex + 1];
  const localPath = domain && image
    ? `/api/brands/integration/${domain}/${image}`
    : '';
  return BRAND_IMAGE_PATH.test(localPath) ? localPath : null;
}

export function getHomeAssistantPublicBrandImageUrl(
  metadata: Record<string, unknown>,
): string | null {
  const attributes = record(metadata.attributes);
  const entityPicture = text(metadata.entityPicture) ?? text(attributes.entity_picture);
  if (!entityPicture) return null;

  let url: URL;
  try {
    url = new URL(entityPicture);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== PUBLIC_BRANDS_HOST) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const domainIndex = segments[0] === '_' ? 1 : 0;
  const domain = segments[domainIndex];
  const image = segments[domainIndex + 1];
  const localPath = domain && image
    ? `/api/brands/integration/${domain}/${image}`
    : '';
  return BRAND_IMAGE_PATH.test(localPath)
    ? `https://${PUBLIC_BRANDS_HOST}/_/${domain}/${image}`
    : null;
}

export function getHomeAssistantBrandImagePath(
  metadata: Record<string, unknown>,
): string | null {
  const attributes = record(metadata.attributes);
  const entityPicture = text(metadata.entityPicture) ?? text(attributes.entity_picture);
  if (entityPicture) {
    const path = normalizeHomeAssistantImagePath(entityPicture);
    if (path) return path;
  }

  const source = text(metadata.haSource);
  const domain = text(metadata.integrationDomain)
    ?? (source === 'repairs' ? text(metadata.domain) : null);
  if (!domain || !/^[a-z0-9_]+$/.test(domain)) return null;
  return `/api/brands/integration/${domain}/icon.png`;
}

function isActiveState(value: string | null): boolean {
  return value !== null && [
    'on',
    'open',
    'opening',
    'unlocked',
    'detected',
    'home',
    'problem',
    'wet',
  ].includes(value.toLowerCase());
}

export function getHomeAssistantMdiIcon(
  metadata: Record<string, unknown>,
): string | null {
  const attributes = record(metadata.attributes);
  const explicitIcon = text(metadata.mdiIcon) ?? text(attributes.icon);
  if (explicitIcon) {
    const normalized = explicitIcon.toLowerCase();
    if (MDI_ICON.test(normalized)) return normalized;
  }

  const entityId = text(metadata.entityId);
  const domain = entityId?.split('.', 1)[0];
  const state = text(metadata.state);
  const deviceClass = (
    text(metadata.deviceClass) ?? text(attributes.device_class)
  )?.toLowerCase();
  const active = isActiveState(state);

  if (domain === 'lock') return active ? 'mdi:lock-open-alert' : 'mdi:lock';
  if (domain === 'update') return 'mdi:package-up';
  if (domain === 'cover') return active ? 'mdi:window-shutter-open' : 'mdi:window-shutter';
  if (domain === 'light') return active ? 'mdi:lightbulb-alert' : 'mdi:lightbulb';
  if (domain === 'switch') return active ? 'mdi:toggle-switch' : 'mdi:toggle-switch-off';
  if (domain === 'device_tracker') return 'mdi:map-marker-alert';
  if (domain === 'alarm_control_panel') return 'mdi:shield-home';

  if (domain === 'binary_sensor') {
    switch (deviceClass) {
      case 'door':
      case 'garage_door':
      case 'opening':
        return active ? 'mdi:door-open' : 'mdi:door-closed';
      case 'window':
        return active ? 'mdi:window-open' : 'mdi:window-closed';
      case 'motion':
      case 'occupancy':
      case 'presence':
        return 'mdi:motion-sensor';
      case 'moisture':
        return 'mdi:water-alert';
      case 'smoke':
        return 'mdi:smoke-detector-alert';
      default:
        return 'mdi:alert-circle-outline';
    }
  }

  if (domain === 'sensor') {
    switch (deviceClass) {
      case 'battery':
        return 'mdi:battery-alert';
      case 'humidity':
        return 'mdi:water-percent-alert';
      case 'temperature':
        return 'mdi:thermometer-alert';
      default:
        return 'mdi:gauge';
    }
  }

  return null;
}
