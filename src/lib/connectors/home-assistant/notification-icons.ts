const BRAND_IMAGE_PATH = /^\/api\/brands\/integration\/([a-z0-9_]+)\/((?:dark_)?icon(?:@2x)?\.png)$/;
const PUBLIC_BRANDS_HOST = 'brands.home-assistant.io';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeBrandPath(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value, 'https://home-assistant.invalid');
  } catch {
    return null;
  }

  if (url.origin === 'https://home-assistant.invalid') {
    return BRAND_IMAGE_PATH.test(url.pathname) ? url.pathname : null;
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

export function getHomeAssistantBrandImagePath(
  metadata: Record<string, unknown>,
): string | null {
  const attributes = record(metadata.attributes);
  const entityPicture = text(metadata.entityPicture) ?? text(attributes.entity_picture);
  if (entityPicture) {
    const path = normalizeBrandPath(entityPicture);
    if (path) return path;
  }

  const source = text(metadata.haSource);
  const domain = text(metadata.integrationDomain)
    ?? (source === 'repairs' ? text(metadata.domain) : null);
  if (!domain || !/^[a-z0-9_]+$/.test(domain)) return null;
  return `/api/brands/integration/${domain}/icon.png`;
}

