// ─── ICON PICKER TYPES ──────────────────────────────────────────────────────

/** Supported icon source prefixes */
export type IconSource = 'emoji' | 'lucide' | 'mdi' | 'ph' | 'dash' | 'si';

/** Parsed representation of an icon value */
export interface ParsedIcon {
  source: IconSource;
  name: string;
}

// ─── SERIALIZATION ──────────────────────────────────────────────────────────

const EMOJI_REGEX = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
const PREFIX_REGEX = /^(lucide|mdi|ph|dash|si):(.+)$/;

/** Parse a stored icon string into source + name */
export function parseIconValue(value: string | null | undefined): ParsedIcon | null {
  if (!value) return null;

  const prefixMatch = value.match(PREFIX_REGEX);
  if (prefixMatch) {
    return { source: prefixMatch[1] as IconSource, name: prefixMatch[2] };
  }

  // Raw emoji (backward compat)
  if (EMOJI_REGEX.test(value)) {
    return { source: 'emoji', name: value };
  }

  // Bare icon name without prefix — assume lucide (backward compat)
  if (/^[a-z][a-z0-9-]*$/.test(value)) {
    return { source: 'lucide', name: value };
  }

  // Might be an emoji that didn't match the regex, or an unrecognized format
  return { source: 'emoji', name: value };
}

/** Serialize a parsed icon back to a storage string */
export function serializeIconValue(icon: ParsedIcon): string {
  if (icon.source === 'emoji') return icon.name;
  return `${icon.source}:${icon.name}`;
}

// ─── CDN URLS ───────────────────────────────────────────────────────────────

/** Validate icon name to prevent URL injection — only allow safe characters */
const SAFE_ICON_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Get a renderable URL for an icon, optionally tinted with a color */
export function getIconUrl(icon: ParsedIcon, color?: string): string | null {
  if (icon.source === 'emoji') return null;

  // Validate icon name to prevent arbitrary URL path injection
  if (!SAFE_ICON_NAME.test(icon.name)) return null;

  const encodedColor = color ? encodeURIComponent(color.replace('#', '')) : null;

  switch (icon.source) {
    case 'lucide':
      return `https://api.iconify.design/lucide/${icon.name}.svg${encodedColor ? `?color=%23${encodedColor}` : ''}`;

    case 'mdi':
      return `https://api.iconify.design/mdi/${icon.name}.svg${encodedColor ? `?color=%23${encodedColor}` : ''}`;

    case 'ph':
      return `https://api.iconify.design/ph/${icon.name}.svg${encodedColor ? `?color=%23${encodedColor}` : ''}`;

    case 'dash':
      return `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${icon.name}.svg`;

    case 'si':
      return `https://cdn.simpleicons.org/${icon.name}${encodedColor ? `/${encodedColor}` : ''}`;

    default:
      return null;
  }
}

// ─── POPULAR ICONS (for initial display before search) ──────────────────────

export const POPULAR_LUCIDE = [
  'home', 'settings', 'user', 'search', 'star', 'heart', 'plus', 'check',
  'x', 'arrow-right', 'arrow-left', 'chevron-down', 'chevron-right',
  'mail', 'calendar', 'clock', 'bell', 'bookmark', 'folder', 'file',
  'image', 'video', 'music', 'camera', 'mic', 'phone', 'globe',
  'map-pin', 'navigation', 'compass', 'sun', 'moon', 'cloud',
  'zap', 'flame', 'rocket', 'target', 'flag', 'tag', 'hash',
  'link', 'paperclip', 'scissors', 'copy', 'clipboard', 'trash-2',
  'edit', 'eye', 'eye-off', 'lock', 'unlock', 'shield', 'key',
  'database', 'server', 'code', 'terminal', 'git-branch', 'box',
  'package', 'layers', 'layout', 'grid-3x3', 'list', 'bar-chart-3',
  'pie-chart', 'trending-up', 'activity', 'cpu', 'wifi', 'bluetooth',
  'battery', 'power', 'download', 'upload', 'refresh-cw', 'loader',
  'alert-circle', 'info', 'help-circle', 'message-circle', 'send',
  'share-2', 'external-link', 'maximize', 'minimize', 'move',
  'crop', 'filter', 'sliders', 'tool', 'wrench', 'hammer',
  'paint-bucket', 'palette', 'brush', 'pen-tool', 'type',
  'bold', 'italic', 'align-left', 'list-ordered', 'table',
  'shopping-cart', 'credit-card', 'dollar-sign', 'gift', 'truck',
  'briefcase', 'building-2', 'graduation-cap', 'award', 'trophy',
  'users', 'user-plus', 'smile', 'thumbs-up', 'coffee',
];

export const POPULAR_MDI = [
  'home', 'account', 'cog', 'magnify', 'star', 'heart', 'plus', 'check',
  'close', 'arrow-right', 'arrow-left', 'chevron-down', 'email',
  'calendar', 'clock', 'bell', 'bookmark', 'folder', 'file',
  'image', 'video', 'music', 'camera', 'microphone', 'phone',
  'earth', 'map-marker', 'navigation', 'weather-sunny', 'weather-night',
  'cloud', 'flash', 'fire', 'rocket', 'target', 'flag', 'tag',
  'link', 'paperclip', 'content-copy', 'clipboard', 'delete',
  'pencil', 'eye', 'eye-off', 'lock', 'lock-open', 'shield',
  'database', 'server', 'code-tags', 'console', 'source-branch',
  'package', 'layers', 'view-dashboard', 'view-grid', 'view-list',
  'chart-bar', 'chart-pie', 'trending-up', 'pulse', 'chip',
  'wifi', 'bluetooth', 'battery', 'power', 'download', 'upload',
  'alert-circle', 'information', 'help-circle', 'message', 'send',
  'share-variant', 'open-in-new', 'fullscreen', 'filter', 'tune',
  'wrench', 'hammer', 'palette', 'brush', 'format-bold',
  'cart', 'credit-card', 'currency-usd', 'gift', 'truck',
  'briefcase', 'office-building', 'school', 'medal', 'trophy',
  'account-group', 'account-plus', 'emoticon', 'thumb-up', 'coffee',
];

export const POPULAR_PHOSPHOR = [
  'house', 'gear', 'user', 'magnifying-glass', 'star', 'heart', 'plus', 'check',
  'x', 'arrow-right', 'arrow-left', 'caret-down', 'envelope',
  'calendar', 'clock', 'bell', 'bookmark-simple', 'folder', 'file',
  'image', 'video-camera', 'music-note', 'camera', 'microphone', 'phone',
  'globe', 'map-pin', 'navigation-arrow', 'sun', 'moon',
  'cloud', 'lightning', 'fire', 'rocket', 'crosshair', 'flag', 'tag',
  'link', 'paperclip', 'copy', 'clipboard', 'trash',
  'pencil-simple', 'eye', 'eye-slash', 'lock', 'lock-open', 'shield',
  'database', 'desktop', 'code', 'terminal', 'git-branch',
  'package', 'stack', 'layout', 'squares-four', 'list-bullets',
  'chart-bar', 'chart-pie', 'trend-up', 'activity', 'cpu',
  'wifi-high', 'bluetooth', 'battery-full', 'power', 'download', 'upload',
  'warning-circle', 'info', 'question', 'chat-circle', 'paper-plane-tilt',
  'share-network', 'arrow-square-out', 'arrows-out', 'funnel', 'sliders',
  'wrench', 'hammer', 'palette', 'paint-brush', 'text-aa',
  'shopping-cart', 'credit-card', 'currency-dollar', 'gift', 'truck',
  'briefcase', 'buildings', 'graduation-cap', 'medal', 'trophy',
  'users-three', 'user-plus', 'smiley', 'thumbs-up', 'coffee',
];

export const POPULAR_DASHBOARD_ICONS = [
  'github', 'gitlab', 'discord', 'slack', 'plex', 'jellyfin', 'sonarr',
  'radarr', 'nextcloud', 'home-assistant', 'grafana', 'prometheus',
  'portainer', 'nginx', 'traefik', 'docker', 'proxmox', 'unraid',
  'pihole', 'adguard-home', 'bitwarden', 'vaultwarden', 'immich',
  'photoprism', 'audiobookshelf', 'calibre', 'paperless-ngx',
  'uptime-kuma', 'truenas', 'synology', 'qnap', 'cloudflare',
  'tailscale', 'wireguard', 'opnsense', 'pfsense', 'ubuntu',
  'debian', 'windows', 'linux', 'apple', 'android',
  'google', 'microsoft', 'amazon', 'aws', 'azure',
  'notion', 'obsidian', 'joplin', 'standard-notes',
  'freshrss', 'miniflux', 'actual-budget', 'firefly-iii',
  'mealie', 'tandoor', 'overseerr', 'bazarr', 'prowlarr',
  'transmission', 'qbittorrent', 'deluge', 'sabnzbd',
  'tautulli', 'organizr', 'homarr', 'dashy', 'homepage',
  'gitea', 'forgejo', 'drone', 'woodpecker-ci', 'jenkins',
  'n8n', 'node-red', 'homebridge', 'zigbee2mqtt',
];

export const POPULAR_SIMPLE_ICONS = [
  'github', 'gitlab', 'bitbucket', 'docker', 'kubernetes',
  'react', 'vuedotjs', 'angular', 'svelte', 'nextdotjs',
  'typescript', 'javascript', 'python', 'go', 'rust',
  'nodedotjs', 'deno', 'bun', 'npm', 'yarn',
  'google', 'apple', 'microsoft', 'amazon', 'meta',
  'slack', 'discord', 'telegram', 'whatsapp', 'signal',
  'twitter', 'linkedin', 'instagram', 'youtube', 'twitch',
  'reddit', 'stackoverflow', 'medium', 'devdotto',
  'figma', 'sketch', 'adobecreativecloud', 'canva',
  'notion', 'obsidian', 'todoist', 'trello', 'jira',
  'vercel', 'netlify', 'cloudflare', 'digitalocean', 'heroku',
  'postgresql', 'mysql', 'mongodb', 'redis', 'sqlite',
  'grafana', 'prometheus', 'elasticsearch', 'nginx',
  'linux', 'ubuntu', 'debian', 'fedora', 'archlinux',
  'visualstudiocode', 'intellijidea', 'vim', 'neovim',
  'stripe', 'paypal', 'shopify', 'wordpress',
  'spotify', 'netflix', 'plex', 'steam',
];
