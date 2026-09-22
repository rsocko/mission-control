import { NextResponse } from 'next/server';
import { createTriageCapture, detectSourcePlatform } from '@/lib/triage/capture';
import { isValidTriageSource } from '@/lib/triage/queue-query';
import { hasValidTriageCaptureKey } from '@/lib/triage/capture-auth';
import { processIOSShareCapture } from '@/lib/native/share-capture-service';
import logger from '@/lib/logger';

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 512 * 1_024) {
      return NextResponse.json({ error: 'Capture request is too large' }, { status: 413 });
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (body && typeof body === 'object' && (body as Record<string, unknown>).client === 'ios') {
      const result = await processIOSShareCapture(request, body);
      return NextResponse.json(result.body, { status: result.status });
    }
    if (!hasValidTriageCaptureKey(request)) {
      return NextResponse.json({ error: 'Unauthorized capture request' }, { status: 401 });
    }
    const legacyBody = body as Record<string, unknown>;
    if (typeof legacyBody.url !== 'string' || !legacyBody.url) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    // Detect the real source platform from the URL. If the extension (or any
    // client) sends an explicit sourcePlatform that is a *real* platform (not
    // the generic 'browser_extension' tag), honour it. Otherwise, detect from
    // the URL so that e.g. saving a Reddit page via the extension groups with
    // Reddit, not "browser_extension".
    const explicitSourcePlatform = typeof legacyBody.sourcePlatform === 'string'
      && isValidTriageSource(legacyBody.sourcePlatform)
      && legacyBody.sourcePlatform !== 'all'
      && legacyBody.sourcePlatform !== 'browser_extension'
      ? legacyBody.sourcePlatform
      : null;
    const detectedPlatform = detectSourcePlatform(legacyBody.url);

    const sourcePlatform = explicitSourcePlatform
      ? explicitSourcePlatform
      : legacyBody.client === 'android'
          ? (detectedPlatform !== 'web' ? detectedPlatform : 'android_share')
          : detectedPlatform !== 'web'
            ? detectedPlatform
            : legacyBody.client === 'browser'
              ? 'browser_extension'
              : 'web';

    const item = await createTriageCapture({
      url: legacyBody.url,
      title: typeof legacyBody.title === 'string' ? legacyBody.title : undefined,
      description: typeof legacyBody.description === 'string' ? legacyBody.description : undefined,
      thumbnailUrl: typeof legacyBody.thumbnailUrl === 'string' ? legacyBody.thumbnailUrl : undefined,
      sharedText: typeof legacyBody.sharedText === 'string' ? legacyBody.sharedText : undefined,
      sourcePlatform,
      sourceId: typeof legacyBody.sourceId === 'string' ? legacyBody.sourceId : undefined,
      capturedAt: typeof legacyBody.capturedAt === 'string' ? legacyBody.capturedAt : undefined,
      platformMeta: legacyBody.platformMeta && typeof legacyBody.platformMeta === 'object'
        ? legacyBody.platformMeta as Record<string, unknown>
        : undefined,
    });

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, 'Failed to capture triage item');
    return NextResponse.json({ error: 'Failed to capture triage item' }, { status: 500 });
  }
}
