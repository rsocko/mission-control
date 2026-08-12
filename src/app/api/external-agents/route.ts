import { NextResponse } from 'next/server';
import {
  createExternalAgent,
  listExternalAgents,
  publicExternalAgent,
  type ExternalAgentInput,
} from '@/lib/external-agents/registry';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';

export async function GET(request: Request) {
  try {
    const includeDeleted = new URL(request.url).searchParams.get('includeDeleted') === 'true';
    return NextResponse.json({ agents: await listExternalAgents({ includeDeleted }) });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const agent = await createExternalAgent(await request.json() as ExternalAgentInput);
    return NextResponse.json({ agent: publicExternalAgent(agent) }, { status: 201 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
