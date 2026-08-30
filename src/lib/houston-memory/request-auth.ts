import 'server-only';
import { isSameOriginRequest, isTrustedMutationRequest } from '@/lib/api/trusted-request';

export function isTrustedHoustonMemoryRequest(request: Request): boolean {
  return isTrustedMutationRequest(request) || isSameOriginRequest(request, 'referer');
}
