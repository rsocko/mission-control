import { NextResponse } from 'next/server';
import {
  deleteExternalAgent,
  getExternalAgent,
  publicExternalAgent,
  updateExternalAgent,
  type ExternalAgentInput,
} from '@/lib/external-agents/registry';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';
import { ExternalAgentError } from '@/lib/external-agents/errors';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const agent = await getExternalAgent((await params).id);
    if (!agent) throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
    return NextResponse.json({ agent: publicExternalAgent(agent) });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    requireTrustedMutation(request);
    const agent = await updateExternalAgent(
      (await params).id,
      await request.json() as Partial<ExternalAgentInput>,
    );
    return NextResponse.json({ agent: publicExternalAgent(agent) });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    requireTrustedMutation(request);
    await deleteExternalAgent((await params).id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
