import type { IconSource } from './types';

interface IconifyIconSet {
  width?: number;
  height?: number;
  icons: Record<string, {
    body: string;
    width?: number;
    height?: number;
  }>;
  aliases?: Record<string, {
    parent: string;
    width?: number;
    height?: number;
  }>;
}

const iconMaskCache = new Map<string, string>();
const MAX_ICON_MASK_CACHE_SIZE = 1_000;

export function iconMaskCacheKey(source: IconSource, name: string) {
  return `${source}:${name}`;
}

function createIconMaskUrl(body: string, width: number, height: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export async function loadIconifyMasks(
  source: IconSource,
  names: string[],
): Promise<Record<string, string | null>> {
  if (!['lucide', 'mdi', 'ph'].includes(source) || names.length === 0) return {};

  const missingNames = names.filter((name) => !iconMaskCache.has(iconMaskCacheKey(source, name)));
  if (missingNames.length > 0) {
    try {
      const params = new URLSearchParams({ icons: missingNames.join(',') });
      const res = await fetch(`https://api.iconify.design/${source}.json?${params}`);
      if (res.ok) {
        const data: IconifyIconSet = await res.json();
        for (const name of missingNames) {
          const alias = data.aliases?.[name];
          const icon = data.icons[name] ?? (alias ? data.icons[alias.parent] : undefined);
          if (!icon) continue;

          const width = alias?.width || icon.width || data.width || 24;
          const height = alias?.height || icon.height || data.height || 24;
          if (iconMaskCache.size >= MAX_ICON_MASK_CACHE_SIZE) {
            const firstKey = iconMaskCache.keys().next().value;
            if (firstKey) iconMaskCache.delete(firstKey);
          }
          iconMaskCache.set(
            iconMaskCacheKey(source, name),
            createIconMaskUrl(icon.body, width, height),
          );
        }
      }
    } catch {
      // Callers fall back to direct Iconify rendering when the batch request fails.
    }
  }

  return Object.fromEntries(
    names.map((name) => [
      iconMaskCacheKey(source, name),
      iconMaskCache.get(iconMaskCacheKey(source, name)) ?? null,
    ]),
  );
}
