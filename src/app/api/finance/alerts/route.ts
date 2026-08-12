/**
 * @deprecated Use /api/finance/notifications instead.
 * Forwards to the new endpoint, remapping response for backward compat.
 */
import { NextResponse } from 'next/server';
import { GET as newGET } from '../notifications/route';

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!url.searchParams.has('severity') && url.searchParams.has('level')) {
    url.searchParams.set('severity', url.searchParams.get('level') || '');
  }

  const response = await newGET(new Request(url.toString(), request));
  const data = await response.json();
  return NextResponse.json({ alerts: data.notifications ?? [] });
}
