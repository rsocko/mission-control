import 'server-only';

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  detectCaptureImageMimeType,
  type CaptureImageMimeType,
} from '@/lib/capture-image';

export interface StoredCaptureImage {
  buffer: Buffer;
  mime: CaptureImageMimeType;
}

export interface CaptureStorageAdapter {
  save(id: string, buffer: Buffer, mime: CaptureImageMimeType): Promise<string>;
  get(id: string): Promise<StoredCaptureImage | null>;
  delete(id: string): Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSIONS: Record<CaptureImageMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

function assertStorageId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new Error('Invalid capture image ID');
  }
}

export class LocalFsCaptureStorage implements CaptureStorageAdapter {
  constructor(private readonly root = process.env.CAPTURE_IMAGE_STORAGE_PATH
    ? path.resolve(/*turbopackIgnore: true*/ process.env.CAPTURE_IMAGE_STORAGE_PATH)
    : path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'data', 'captures')) {}

  async save(id: string, buffer: Buffer, mime: CaptureImageMimeType): Promise<string> {
    assertStorageId(id);
    const detectedMime = detectCaptureImageMimeType(buffer);
    if (detectedMime !== mime) {
      throw new Error('Capture image content does not match its MIME type');
    }

    await mkdir(this.root, { recursive: true });
    await writeFile(this.filePath(id, mime), buffer, { flag: 'wx' });
    return `/api/triage/capture/image/${id}`;
  }

  async get(id: string): Promise<StoredCaptureImage | null> {
    assertStorageId(id);

    for (const mime of Object.keys(EXTENSIONS) as CaptureImageMimeType[]) {
      try {
        const buffer = await readFile(this.filePath(id, mime));
        if (detectCaptureImageMimeType(buffer) !== mime) {
          throw new Error('Stored capture image failed integrity validation');
        }
        return { buffer, mime };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    return null;
  }

  async delete(id: string): Promise<void> {
    assertStorageId(id);
    await Promise.all((Object.keys(EXTENSIONS) as CaptureImageMimeType[]).map(async (mime) => {
      try {
        await unlink(this.filePath(id, mime));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }));
  }

  private filePath(id: string, mime: CaptureImageMimeType): string {
    return path.join(/*turbopackIgnore: true*/ this.root, `${id}.${EXTENSIONS[mime]}`);
  }
}

let storage: CaptureStorageAdapter | null = null;

export function getCaptureImageStorage(): CaptureStorageAdapter {
  storage ??= new LocalFsCaptureStorage();
  return storage;
}
