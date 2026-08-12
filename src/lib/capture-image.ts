export const DEFAULT_CAPTURE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const OFFLINE_IMAGE_MAX_COUNT = 20;
export const OFFLINE_IMAGE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export const CAPTURE_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;

export type CaptureImageMimeType = typeof CAPTURE_IMAGE_MIME_TYPES[number];

export function isCaptureImageMimeType(value: string): value is CaptureImageMimeType {
  return CAPTURE_IMAGE_MIME_TYPES.includes(value as CaptureImageMimeType);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export function detectCaptureImageMimeType(bytes: Uint8Array): CaptureImageMimeType | null {
  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && ascii(bytes, 1, 3) === 'PNG'
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 12
    && ascii(bytes, 0, 4) === 'RIFF'
    && ascii(bytes, 8, 4) === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const heicBrands = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
    for (let offset = 8; offset + 4 <= Math.min(bytes.length, 40); offset += 4) {
      if (heicBrands.has(ascii(bytes, offset, 4))) return 'image/heic';
    }
  }

  return null;
}

export function getCaptureImageMaxBytes(): number {
  const configured = Number(process.env.CAPTURE_IMAGE_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_CAPTURE_IMAGE_MAX_BYTES;
}
