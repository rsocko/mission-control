import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  OwlTaskActionError,
  parseOwlTaskActionInput,
  performOwlTaskAction,
} from '@/lib/connectors/document-intelligence/task-actions';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return ApiErrors.badRequest('Request body must be valid JSON');
  }

  const input = parseOwlTaskActionInput(body);
  if (!input) {
    return ApiErrors.validation('Invalid OWL task action payload');
  }

  try {
    const task = await performOwlTaskAction(id, input);
    return NextResponse.json({ success: true, task });
  } catch (error) {
    if (error instanceof OwlTaskActionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return ApiErrors.internal('Failed to apply OWL task action', error);
  }
}
