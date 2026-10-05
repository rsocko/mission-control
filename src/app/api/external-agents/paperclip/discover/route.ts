import { NextResponse } from 'next/server';
import {
  discoverPaperclipSetup,
  type PaperclipDiscoveryInput,
} from '@/lib/external-agents/registry';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const discovery = await discoverPaperclipSetup(
      await request.json() as PaperclipDiscoveryInput,
    );
    return NextResponse.json(discovery);
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
