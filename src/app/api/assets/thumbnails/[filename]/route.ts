import { NextResponse } from 'next/server';
import { readCachedThumbnail } from '@/lib/triage/thumbnail-cache';

/**
 * GET /api/assets/thumbnails/[filename]
 *
 * Serves a cached thumbnail from the local data volume.
 * Includes aggressive caching headers since these files are immutable.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;

  const result = readCachedThumbnail(filename);
  if (!result) {
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      'Content-Type': result.contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(result.buffer.length),
    },
  });
}
