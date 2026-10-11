import { NextResponse } from 'next/server';
import {
  createExternalAgent,
  listExternalAgents,
  publicExternalAgent,
  type ExternalAgentInput,
} from '@/lib/external-agents/registry';
import { ExternalAgentError } from '@/lib/external-agents/errors';
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
    const input = await request.json() as ExternalAgentInput;
    if (
      input.type === 'copilot-cloud'
      && (await listExternalAgents()).some((agent) => agent.type === 'copilot-cloud')
    ) {
      throw new ExternalAgentError(
        'GitHub Copilot Cloud is already configured',
        'DESTINATION_ALREADY_EXISTS',
        409,
      );
    }
    const agent = await createExternalAgent(input);
    return NextResponse.json({ agent: publicExternalAgent(agent) }, { status: 201 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
