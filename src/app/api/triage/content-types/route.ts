import { NextResponse } from 'next/server';
import {
  getContentTypes,
  upsertContentType,
  deleteContentType,
  suppressContentType,
  getBuiltinTypeIds,
} from '@/lib/triage/content-type-registry';

export async function GET() {
  try {
    const types = await getContentTypes();
    return NextResponse.json({
      contentTypes: types,
      builtinIds: getBuiltinTypeIds(),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to load content types' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    // Suppress/unsuppress a built-in type
    if (body.action === 'suppress') {
      if (!body.id) {
        return NextResponse.json({ error: 'Missing "id" for suppress action' }, { status: 400 });
      }
      await suppressContentType(body.id as string, body.suppressed !== false);
      const types = await getContentTypes();
      return NextResponse.json({ contentTypes: types, message: `Content type "${body.id}" ${body.suppressed !== false ? 'suppressed' : 'restored'}` });
    }

    // Delete a user-defined type
    if (body.action === 'delete') {
      if (!body.id) {
        return NextResponse.json({ error: 'Missing "id" for delete action' }, { status: 400 });
      }
      const deleted = await deleteContentType(body.id as string);
      if (!deleted) {
        return NextResponse.json({ error: 'Cannot delete built-in content types. Use suppress instead.' }, { status: 400 });
      }
      const types = await getContentTypes();
      return NextResponse.json({ contentTypes: types, message: `Content type "${body.id}" deleted` });
    }

    // Create or update a content type
    if (!body.name) {
      return NextResponse.json({ error: 'Missing required field "name"' }, { status: 400 });
    }

    // Validate url patterns are valid regex
    if (body.urlPatterns && Array.isArray(body.urlPatterns)) {
      for (const pattern of body.urlPatterns as string[]) {
        try {
          new RegExp(pattern);
        } catch {
          return NextResponse.json({ error: `Invalid regex pattern: "${pattern}"` }, { status: 400 });
        }
      }
    }

    const result = await upsertContentType({
      id: body.id as string | undefined,
      name: body.name as string,
      icon: body.icon as string | undefined,
      color: body.color as string | undefined,
      suppressed: body.suppressed as boolean | undefined,
      priority: body.priority as number | undefined,
      urlPatterns: body.urlPatterns as string[] | undefined,
      keywordHints: body.keywordHints as string[] | undefined,
      description: body.description as string | undefined,
    });

    const types = await getContentTypes();
    return NextResponse.json({ contentTypes: types, updated: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save content type';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
