import { getCaptureImageStorage } from '@/lib/triage/capture-image-storage';
import { findTriageImageCaptureByImageUrl } from '@/lib/triage/capture';

export const runtime = 'nodejs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
} as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return Response.json({ error: 'Image not found' }, { status: 404 });
  }

  const imageUrl = `/api/triage/capture/image/${id}`;
  if (!await findTriageImageCaptureByImageUrl(imageUrl)) {
    return Response.json({ error: 'Image not found' }, { status: 404 });
  }

  const image = await getCaptureImageStorage().get(id);
  if (!image) {
    return Response.json({ error: 'Image not found' }, { status: 404 });
  }

  const body = new Uint8Array(image.buffer.byteLength);
  body.set(image.buffer);

  return new Response(body.buffer, {
    headers: {
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': `inline; filename="capture.${EXTENSIONS[image.mime]}"`,
      'Content-Length': String(image.buffer.byteLength),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Type': image.mime,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
