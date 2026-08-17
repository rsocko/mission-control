import { NextResponse } from 'next/server';
import {
  applyTriageAction,
  isUndoableTriageAction,
  TriageActionInProgressError,
  undoTriageAction,
} from '@/lib/triage/actions';
import { getTriageItemById } from '@/lib/triage/query';
import { hardDeleteTriageItem } from '@/lib/triage/lifecycle';
import { createGitHubIssue, buildGitHubIssueActionRecord } from '@/lib/triage/actions/github-issue';
import logger from '@/lib/logger';
import type { CreateTodoTaskOptions } from '@/lib/triage/actions/ms-todo';
import type { ModelCatalogOptions } from '@/lib/triage/actions/model-catalog';
import type { KnowledgeBaseOptions } from '@/lib/triage/actions/knowledge-base';
import { isDemoMode } from '@/lib/mode';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json();

    if (body.undo === true) {
      if (
        typeof body.actionType !== 'string'
        || !body.actionType
        || !isUndoableTriageAction(body.actionType)
        || typeof body.actionId !== 'string'
        || !body.actionId
      ) {
        return NextResponse.json(
          { error: 'A swipe actionType and actionId are required to undo an action' },
          { status: 400 },
        );
      }

      const item = await undoTriageAction(id, body.actionType, body.actionId);
      if (!item) {
        return NextResponse.json(
          { error: 'This action can no longer be undone' },
          { status: 409 },
        );
      }

      return NextResponse.json({ item });
    }

    if (typeof body.actionType !== 'string' || !body.actionType) {
      return NextResponse.json({ error: 'actionType is required' }, { status: 400 });
    }

    // Handle GitHub issue creation with side effects
    if (body.actionType === 'create_task_github' && !isDemoMode()) {
      const triageItem = await getTriageItemById(id);
      if (!triageItem) {
        return NextResponse.json({ error: 'Triage item not found' }, { status: 404 });
      }

      const result = await createGitHubIssue(triageItem, {
        repo: body.repo,
        title: body.title,
        body: body.body,
        labels: body.labels,
      });

      const record = buildGitHubIssueActionRecord(result);
      const updatedItem = await applyTriageAction(id, 'create_task_github', record.note);

      return NextResponse.json({ item: updatedItem, githubIssue: result });
    }

    // Extract MS Todo options when action is create_task_todo
    let todoOptions: CreateTodoTaskOptions | undefined;
    if (body.actionType === 'create_task_todo') {
      todoOptions = {
        listId: body.listId,
        listName: body.listName,
        title: body.title,
        body: body.body,
      };
    }

    // Extract Model Catalog options when action is save_model_catalog
    let modelCatalogOptions: ModelCatalogOptions | undefined;
    if (body.actionType === 'save_model_catalog') {
      modelCatalogOptions = {
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        status: typeof body.status === 'string' ? body.status : undefined,
      };
    }

    // Extract Knowledge Base options when action is save_knowledge_base
    let knowledgeBaseOptions: KnowledgeBaseOptions | undefined;
    if (body.actionType === 'save_knowledge_base') {
      knowledgeBaseOptions = {
        category: typeof body.category === 'string' ? body.category : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        path: typeof body.path === 'string' ? body.path : undefined,
      };
    }

    const item = await applyTriageAction(
      id,
      body.actionType,
      typeof body.note === 'string' ? body.note : undefined,
      body.actionType === 'save_karakeep'
        ? { tags: Array.isArray(body.tags) ? body.tags : undefined, list: typeof body.list === 'string' ? body.list : undefined }
        : undefined,
      todoOptions,
      modelCatalogOptions,
      knowledgeBaseOptions,
      isDemoMode() || body.skipExternalAction ? { skipExternalAction: true } : undefined,
    );

    if (!item) {
      return NextResponse.json({ error: 'Triage item not found' }, { status: 404 });
    }

    return NextResponse.json({ item });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update triage item';
    if (error instanceof TriageActionInProgressError) {
      return NextResponse.json(
        { error: message, code: 'TRIAGE_ACTION_IN_PROGRESS' },
        { status: 409 },
      );
    }
    logger.error({ err: error }, 'Failed to update triage item');
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/triage/[id]
 *
 * Permanently deletes a triage item and its cached thumbnail.
 * This is irreversible — use dismiss for soft removal.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const deleted = await hardDeleteTriageItem(id);

    if (!deleted) {
      return NextResponse.json({ error: 'Triage item not found' }, { status: 404 });
    }

    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete triage item');
    return NextResponse.json({ error: 'Failed to delete triage item' }, { status: 500 });
  }
}