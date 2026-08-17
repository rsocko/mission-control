import type { TagApiOperation } from './api';

export interface TagMutationBusyState {
  operation: TagApiOperation | 'bulk-delete';
  tagId?: string;
  token: number;
}

export type TagMutationBusyAction =
  | { type: 'start'; mutation: TagMutationBusyState }
  | { type: 'finish'; token: number };

export function tagMutationBusyReducer(
  state: TagMutationBusyState | null,
  action: TagMutationBusyAction,
): TagMutationBusyState | null {
  if (action.type === 'start') return state ?? action.mutation;
  return state?.token === action.token ? null : state;
}
