import { ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import {
  isWorkspaceConflict,
  isWorkspaceValidationError,
} from '@/lib/graph-workspace/service';

export function workspaceRouteError(message: string, error: unknown) {
  if (isWorkspaceValidationError(error)) {
    return ApiErrors.validation(error.issues[0]?.message ?? 'Invalid workspace request');
  }
  if (isWorkspaceConflict(error)) {
    return Response.json(
      {
        error: error.message,
        code: 'WORKSPACE_CONFLICT',
        current: error.current,
      },
      { status: 409 },
    );
  }
  return ApiErrors.internal(message, error);
}

export function rejectUntrustedWorkspaceMutation(request: Request) {
  return isTrustedMutationRequest(request)
    ? null
    : ApiErrors.forbidden('A same-origin request or valid Mission Control API key is required');
}
