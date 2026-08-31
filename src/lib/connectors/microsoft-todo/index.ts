import type { IConnector, ConnectorFactory } from '../index';
import type {
 TaskItem,
 InboundNotification,
 ConnectorConfig,
 ConnectorCapabilities,
 SourceList,
 SyncResult,
} from '@/types';
import { randomUUID } from 'crypto';
import { getTimezone } from '@/lib/mode';
import { connectorLogger } from '@/lib/logger';
import { getLocalToday } from '@/lib/utils/date';
import { compareRecurringOccurrencePriority } from '@/lib/sync/recurring-task-reconciliation';
import { MICROSOFT_TODO_TASK_AUTHORITY } from '../task-source-profiles';
import { mergeAsyncStreams } from '../task-page-stream';
import { isMicroStatusSyncEnabled, updateTagsWithMicroStatus } from '@/lib/micro-status';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { mergeConnectorSettings } from '../shared/connector-config-store';

import { createGraphClient, GRAPH_BASE_URL, SUBSTRATE_BASE_URL } from './graph-client';
import type { GraphClient } from './graph-client';
import { mapGraphTask, mapSubstrateTask, mapChecklistItem, mapStatus, statusToGraph, priorityToImportance, parseSourceId } from './task-transformer';
import type {
  GraphChecklistItem,
  GraphLinkedResource,
  GraphTodoList,
  GraphTodoTask,
  MicrosoftTodoConfig,
  SubstrateMyDayTask,
} from './types';

export type { SubstrateMyDayTask } from './types';

function removeBufferedRecurringTask(tasks: TaskItem[], sourceId: string): void {
  const index = tasks.findIndex(task => task.sourceId === sourceId);
  if (index === -1) return;
  const parentId = tasks[index].id;
  tasks.splice(index, 1);
  for (let childIndex = tasks.length - 1; childIndex >= 0; childIndex--) {
    if (tasks[childIndex].parentId === parentId) tasks.splice(childIndex, 1);
  }
}

export class MicrosoftTodoConnector implements IConnector {
  readonly id: string = '';
  readonly type = 'microsoft-todo';
  readonly displayName = 'Microsoft Todo';
  readonly icon = '✅';
  readonly capabilities: ConnectorCapabilities = {
    read: true,
    write: true,
    delete: true,
    sync: true,
    subtasks: true,
    lists: true,
    tags: true,
    tagWriteBack: true,
    priority: true,
    priorityWriteBack: true,
    dueDate: true,
    microStatusSync: true,
    microStatusWriteBack: true,
    listSelectionMode: 'optional',
    tagScope: 'global',
    tagCreationMode: 'freeform',
    managedRecurrence: true,
    attachments: true,
    taskCreate: true,
    ...MICROSOFT_TODO_TASK_AUTHORITY,
  };

  private config: ConnectorConfig | null = null;
  private accessToken: string = '';
  private deltaToken: string | null = null;
  private client!: GraphClient;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;
    const creds = config.credentials as unknown as MicrosoftTodoConfig;
    if (creds.accessToken) {
      this.accessToken = creds.accessToken;
    }
    this.client = createGraphClient(config.id);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const res = await this.client.graphFetch('/me/todo/lists');
      if (res.ok) {
        const data = await res.json();
        if (this.config) {
          try {
            const meRes = await this.client.graphFetch('/me');
            if (meRes.ok) {
              const me = await meRes.json();
              const currentSettings = (this.config.settings || {}) as Record<string, unknown>;
              this.config.settings = await mergeConnectorSettings(
                this.config.id,
                currentSettings,
                {
                  authenticatedUser: me.userPrincipalName || me.mail || me.displayName,
                },
              ) as ConnectorConfig['settings'];
            }
          } catch { /* Non-critical */ }
        }
        return { success: true, message: `Connected. Found ${data.value.length} lists.` };
      }
      return { success: false, message: `HTTP ${res.status}: ${res.statusText}` };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err}` };
    }
  }

  async dispose(): Promise<void> {
    this.config = null;
    this.accessToken = '';
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    let allLists: GraphTodoList[] = [];
    let url = '/me/todo/lists?$top=100';

    while (url) {
      const res = await this.client.graphFetch(url);
      if (!res.ok) throw new Error(`Failed to fetch lists: ${res.status}`);
      const data = await res.json();
      allLists = allLists.concat(data.value || []);
      url = data['@odata.nextLink'] ? data['@odata.nextLink'].replace(GRAPH_BASE_URL, '') : '';
    }

    const knownIds = new Set(allLists.map(l => l.id));

    // Discover hidden lists via Substrate
    const hiddenFolderIds = new Set<string>();
    try {
      const res = await this.client.substrateFetch(
        '/taskfolders?$select=*,AllExtensions/Com_Wunderlist_Import,AllExtensions/com_microsoft_uno&maxpagesize=200'
      );
      if (res.ok) {
        const data = await res.json();
        const substrateFolders = data.value || data.Value || [];
        for (const folder of substrateFolders) {
          const folderId = folder.Id || folder.id;
          if (folderId && !knownIds.has(folderId)) {
            const name = folder.Name || folder.name || folder.DisplayName || folder.displayName;
            if (name) {
              allLists.push({
                id: folderId,
                displayName: name,
                wellKnownListName: folder.IsDefaultFolder ? 'defaultList' : 'none',
                isOwner: folder.IsOwner ?? true,
                isShared: folder.IsSharedFolder ?? false,
                parentFolderGroupId: folder.ParentFolderGroupId || undefined,
              });
              hiddenFolderIds.add(folderId);
            }
          } else if (folderId && knownIds.has(folderId)) {
            if (folder.ParentFolderGroupId) {
              const existing = allLists.find(l => l.id === folderId);
              if (existing) existing.parentFolderGroupId = folder.ParentFolderGroupId;
            }
          }
        }
        if (hiddenFolderIds.size > 0) {
          connectorLogger.info({ hiddenFolderCount: hiddenFolderIds.size, totalListCount: allLists.length }, 'Discovered additional source lists via Substrate task folders');
        }
      }
    } catch (e) {
      connectorLogger.warn({ err: e }, 'Substrate task folder discovery failed');
    }

    // Fallback discovery via task scanning — cap at 10 pages to avoid prolonged blocking
    if (hiddenFolderIds.size === 0) {
      try {
        const taskEndpoints = ['/tasks?$top=500', '/tasks?$top=500&$filter=Status eq \'Completed\''];
        for (const startUrl of taskEndpoints) {
          let taskUrl: string | null = startUrl;
          let pages = 0;
          while (taskUrl && pages < 10) {
            pages++;
            const res = await this.client.substrateFetch(taskUrl);
            if (!res.ok) break;
            const data = await res.json();
            const tasks = data.value || data.Value || [];
            if (tasks.length === 0) break;
            for (const t of tasks) {
              const folderId = t.ParentFolderId || t.parentFolderId;
              if (folderId && !knownIds.has(folderId)) hiddenFolderIds.add(folderId);
            }
            const nextLink = data['@odata.nextLink'] || data['@nextLink'] || '';
            taskUrl = nextLink ? nextLink.replace(SUBSTRATE_BASE_URL, '') : '';
            // Yield between pages to keep event loop responsive
            if (taskUrl) await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
      } catch (e) {
        connectorLogger.warn({ err: e }, 'Substrate task discovery fallback failed');
      }
    }

    // Resolve hidden folder names
    const unresolvedFolderIds = new Set<string>();
    for (const folderId of hiddenFolderIds) {
      if (!allLists.some(l => l.id === folderId)) unresolvedFolderIds.add(folderId);
    }

    for (const folderId of unresolvedFolderIds) {
      try {
        const res = await this.client.graphFetch(`/me/todo/lists/${encodeURIComponent(folderId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.displayName) {
            allLists.push({ id: folderId, displayName: data.displayName, wellKnownListName: data.wellKnownListName || 'none', isOwner: data.isOwner ?? true, isShared: data.isShared ?? false });
            continue;
          }
        }
      } catch { /* fall through */ }

      try {
        const res = await this.client.substrateFetch(`/taskfolders/${encodeURIComponent(folderId)}`);
        if (res.ok) {
          const folder = await res.json();
          const name = folder.Name || folder.name || folder.DisplayName || folder.displayName;
          if (name) {
            allLists.push({ id: folderId, displayName: name, wellKnownListName: 'none', isOwner: true, isShared: false });
            continue;
          }
        }
      } catch { /* last resort */ }

      allLists.push({ id: folderId, displayName: `[Hidden List]`, wellKnownListName: 'none', isOwner: true, isShared: false });
    }

    return allLists.map((list) => ({
      id: `${this.id}:${list.id}`,
      connectorInstanceId: this.id,
      sourceId: list.id,
      name: list.displayName,
      type: 'list' as const,
      taskCount: 0,
      lastSyncedAt: new Date().toISOString(),
      wellKnownListName: list.wellKnownListName && list.wellKnownListName !== 'none' ? list.wellKnownListName : undefined,
      parentFolderGroupId: list.parentFolderGroupId,
    }));
  }

  async fetchFolderGroups(): Promise<Array<{ id: string; name: string; orderDateTime?: string }>> {
    try {
      const res = await this.client.substrateFetch('/foldergroups');
      if (!res.ok) return [];
      const data = await res.json();
      const groups = data.value || data.Value || [];
      return groups.map((g: Record<string, unknown>) => ({
        id: g.Id as string || g.id as string,
        name: g.Name as string || g.name as string,
        orderDateTime: g.OrderDateTime as string || undefined,
      }));
    } catch { return []; }
  }

  async *fetchTasks(since?: Date): AsyncGenerator<TaskItem[], void, unknown> {
    connectorLogger.info({ since: since?.toISOString() ?? null }, 'Starting Microsoft Todo task fetch');
    const lists = await this.getListsToSync();
    const fetchedListIds = new Set(lists.map(l => l.id));
    let taskCount = 0;

    const listStreams = lists.map(list => this.fetchListTaskPages(list, since));
    for await (const page of mergeAsyncStreams(listStreams, 3)) {
      taskCount += page.length;
      yield page;
    }

    // Hidden list tasks: source lists Mission Control already knows about that
    // the remote list enumeration did not return this run.
    try {
      const execution = (await getWorkerPersistenceRepositories()).execution;
      const localLists = await execution.lists.list(this.id);

      for (const local of localLists) {
        if (!fetchedListIds.has(local.sourceId)) {
          try {
            let listName = local.name;
            try {
              const listRes = await this.client.graphFetch(`/me/todo/lists/${encodeURIComponent(local.sourceId)}`);
              if (listRes.ok) {
                const listData = await listRes.json();
                if (listData.displayName) listName = listData.displayName;
              }
            } catch { /* use DB name */ }

            for await (const page of this.fetchTasksFromList(local.sourceId, listName, since)) {
              taskCount += page.length;
              yield page;
            }
            fetchedListIds.add(local.sourceId);
          } catch { /* not accessible */ }
        }
      }
    } catch (e) {
      connectorLogger.warn({ err: e }, 'Hidden list source-list lookup failed');
    }

    // Substrate hidden list tasks
    try {
      for await (const page of this.fetchTasksFromHiddenLists(fetchedListIds, since)) {
        taskCount += page.length;
        yield page;
      }
    } catch (e) {
      connectorLogger.warn({ err: e }, 'Hidden list Substrate fetch failed');
    }

    connectorLogger.info({ taskCount }, 'Completed Microsoft Todo task fetch');
  }

  private async *fetchListTaskPages(
    list: GraphTodoList,
    since?: Date,
  ): AsyncGenerator<TaskItem[], void, unknown> {
    try {
      yield* this.fetchTasksFromList(list.id, list.displayName, since, list.wellKnownListName);
    } catch (err) {
      connectorLogger.error({ err, listName: list.displayName }, 'Failed to fetch tasks from list');
    }
  }

  async fetchNotifications(_since?: Date): Promise<InboundNotification[]> { return []; }

  async createTask(task: Partial<TaskItem>): Promise<TaskItem> {
    const listId = task.sourceListId || await this.getDefaultListId();
    const metadata = task.metadata as Record<string, unknown> | undefined;
    const missionControlTaskId = metadata?.missionControlTaskId;
    const heartbeat = typeof metadata?.missionControlPushHeartbeat === 'function'
      ? metadata.missionControlPushHeartbeat as () => Promise<void>
      : null;
    const marker = typeof missionControlTaskId === 'string'
      ? `[Mission Control Task ID: ${missionControlTaskId}]`
      : null;

    if (marker) {
      let url = `/me/todo/lists/${listId}/tasks?$top=100`;
      while (url) {
        await heartbeat?.();
        const existingRes = await this.client.graphFetch(url);
        if (!existingRes.ok) throw new Error(`Failed to reconcile task creation: ${existingRes.status}`);
        const data = await existingRes.json() as {
          value?: GraphTodoTask[];
          '@odata.nextLink'?: string;
        };
        const existing = data.value?.find((candidate) => candidate.body?.content?.includes(marker));
        if (existing) {
          return mapGraphTask(existing, listId, '', this.type, this.id);
        }
        url = data['@odata.nextLink']?.replace(GRAPH_BASE_URL, '') || '';
      }
    }

    await heartbeat?.();
    const description = [task.description, marker].filter(Boolean).join('\n\n');
    const body: Record<string, unknown> = {
      title: task.title,
      body: description ? { content: description, contentType: 'text' } : undefined,
      importance: priorityToImportance(task.priority),
      dueDateTime: task.dueDate ? { dateTime: task.dueDate, timeZone: getTimezone() } : undefined,
    };

    const recurrencePattern = metadata?.recurrence as string | undefined;
    if (recurrencePattern && recurrencePattern !== 'none') {
      body.recurrence = this.buildRecurrencePattern(recurrencePattern, task.dueDate);
    }

    const res = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks`, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Failed to create task: ${res.status}`);
    const created = await res.json();
    return mapGraphTask(created, listId, '', this.type, this.id);
  }

  async updateTask(sourceId: string, updates: Partial<TaskItem>): Promise<TaskItem> {
    const { listId, taskId } = parseSourceId(sourceId);
    const body: Record<string, unknown> = {};

    if (updates.title) body.title = updates.title;
    if (updates.description) body.body = { content: updates.description, contentType: 'text' };
    if (updates.priority) body.importance = priorityToImportance(updates.priority);
    if (updates.dueDate) body.dueDateTime = { dateTime: updates.dueDate, timeZone: getTimezone() };
    if (updates.status !== undefined) body.status = statusToGraph(updates.status);

    const metadata = updates.metadata as Record<string, unknown> | undefined;
    const recurrencePattern = metadata?.recurrence as string | undefined;
    if (recurrencePattern !== undefined) {
      body.recurrence = recurrencePattern && recurrencePattern !== 'none'
        ? this.buildRecurrencePattern(recurrencePattern, updates.dueDate)
        : null;
    }

    const isTerminalUpdate = updates.status === 'done' || updates.status === 'cancelled';
    if (
      updates.microStatus !== undefined
      && (
        isTerminalUpdate
        || isMicroStatusSyncEnabled((this.config?.settings || {}) as Record<string, unknown>)
      )
    ) {
      body.categories = await this.getCategoriesWithMicroStatus(listId, taskId, updates.microStatus || null);
    }

    const res = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Failed to update task: ${res.status}`);
    const updated = await res.json();
    return mapGraphTask(updated, listId, '', this.type, this.id);
  }

  async completeTask(sourceId: string): Promise<void> {
    const { listId, taskId } = parseSourceId(sourceId);
    const categories = await this.getCategoriesWithMicroStatus(listId, taskId, null);
    const res = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', categories }),
    });
    if (res.status === 404) return; // Task already deleted remotely — treat as success
    if (!res.ok) throw new Error(`Failed to complete task: ${res.status}`);
  }

  private async getCategoriesWithMicroStatus(
    listId: string,
    taskId: string,
    microStatus: string | null,
  ): Promise<string[]> {
    const currentRes = await this.client.graphFetch(
      `/me/todo/lists/${listId}/tasks/${taskId}?$select=categories`,
    );
    if (currentRes.status === 404) return [];
    if (!currentRes.ok) {
      throw new Error(`Failed to fetch task categories: ${currentRes.status}`);
    }
    const currentData = await currentRes.json();
    const currentCategories = Array.isArray(currentData.categories) ? currentData.categories : [];
    return updateTagsWithMicroStatus(currentCategories, microStatus);
  }

  async createSubTask(parentSourceId: string, task: Partial<TaskItem>): Promise<TaskItem> {
    const { listId, taskId } = parseSourceId(parentSourceId);
    const body = { displayName: task.title || 'Untitled', isChecked: task.status === 'done' };
    const res = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Failed to create checklist item: ${res.status}`);
    const created = await res.json();
    return mapChecklistItem(created, listId, taskId, '', this.type, this.id);
  }

  async completeSubTask(parentSourceId: string, subTaskSourceId: string): Promise<void> {
    const { listId, taskId } = parseSourceId(parentSourceId);
    const parts = subTaskSourceId.split(':');
    const checklistItemId = parts.length >= 3 ? parts[parts.length - 1] : subTaskSourceId;
    const res = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${checklistItemId}`, { method: 'PATCH', body: JSON.stringify({ isChecked: true }) });
    if (res.status === 404) return; // Task or checklist item already deleted remotely — treat as success
    if (!res.ok) throw new Error(`Failed to complete checklist item: ${res.status}`);
  }

  async updateSubTask(parentSourceId: string, subTaskSourceId: string, updates: Partial<TaskItem>): Promise<void> {
    const { listId, taskId } = parseSourceId(parentSourceId);
    const parts = subTaskSourceId.split(':');
    const checklistItemId = parts.length >= 3 ? parts[parts.length - 1] : subTaskSourceId;
    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.displayName = updates.title;
    if (updates.status !== undefined) body.isChecked = updates.status === 'done';
    const res = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${checklistItemId}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (res.status === 404) return; // Task or checklist item already deleted remotely — treat as success
    if (!res.ok) throw new Error(`Failed to update checklist item: ${res.status}`);
  }

  async deleteTask(sourceId: string): Promise<void> {
    const { listId, taskId } = parseSourceId(sourceId);
    const res = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}`, { method: 'DELETE' });
    if (res.status === 404) return; // Task already deleted remotely — treat as success
    if (!res.ok) throw new Error(`Failed to delete task: ${res.status}`);
  }

  // ─── Attachment Methods ─────────────────────────────────────────────────

  async uploadAttachment(sourceId: string, file: { name: string; contentType: string; contentBase64: string }): Promise<{ id: string; name: string; size: number }> {
    const { listId, taskId } = parseSourceId(sourceId);
    const sizeBytes = Math.ceil(file.contentBase64.length * 3 / 4);

    // Use direct POST for files < 3MB, upload session for larger
    if (sizeBytes < 3 * 1024 * 1024) {
      const body = {
        '@odata.type': '#microsoft.graph.taskFileAttachment',
        name: file.name,
        contentType: file.contentType,
        contentBytes: file.contentBase64,
      };
      const res = await this.client.graphFetch(
        `/me/todo/lists/${listId}/tasks/${taskId}/attachments`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Failed to upload attachment: ${res.status} ${errText}`);
      }
      const data = await res.json();
      return { id: data.id, name: data.name || file.name, size: data.size || sizeBytes };
    }

    // Large file: create upload session
    const sessionBody = {
      attachmentInfo: {
        attachmentType: 'file',
        name: file.name,
        size: sizeBytes,
      },
    };
    const sessionRes = await this.client.graphFetch(
      `/me/todo/lists/${listId}/tasks/${taskId}/attachments/createUploadSession`,
      { method: 'POST', body: JSON.stringify(sessionBody) },
    );
    if (!sessionRes.ok) throw new Error(`Failed to create upload session: ${sessionRes.status}`);
    const sessionData = await sessionRes.json();
    const uploadUrl = sessionData.uploadUrl;

    // Upload in 4MB chunks
    const binaryContent = Buffer.from(file.contentBase64, 'base64');
    const chunkSize = 4 * 1024 * 1024;
    let offset = 0;
    let lastResponse: { id?: string; name?: string; size?: number } = {};

    while (offset < binaryContent.length) {
      const end = Math.min(offset + chunkSize, binaryContent.length);
      const chunk = binaryContent.subarray(offset, end);
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${offset}-${end - 1}/${binaryContent.length}`,
        },
        body: chunk,
      });
      if (!putRes.ok && putRes.status !== 200 && putRes.status !== 201) {
        throw new Error(`Upload chunk failed: ${putRes.status}`);
      }
      if (putRes.status === 200 || putRes.status === 201) {
        lastResponse = await putRes.json();
      }
      offset = end;
    }

    return {
      id: lastResponse.id || '',
      name: lastResponse.name || file.name,
      size: lastResponse.size || sizeBytes,
    };
  }

  async listAttachments(sourceId: string): Promise<Array<{ id: string; name: string; contentType: string; size: number }>> {
    const { listId, taskId } = parseSourceId(sourceId);
    const res = await this.client.graphFetch(
      `/me/todo/lists/${listId}/tasks/${taskId}/attachments`,
    );
    if (!res.ok) throw new Error(`Failed to list attachments: ${res.status}`);
    const data = await res.json();
    const items = data.value || [];
    return items.map((att: { id: string; name: string; contentType?: string; size?: number }) => ({
      id: att.id,
      name: att.name || 'Unnamed',
      contentType: att.contentType || 'application/octet-stream',
      size: att.size || 0,
    }));
  }

  async deleteAttachment(sourceId: string, attachmentId: string): Promise<void> {
    const { listId, taskId } = parseSourceId(sourceId);
    const res = await this.client.graphFetch(
      `/me/todo/lists/${listId}/tasks/${taskId}/attachments/${attachmentId}`,
      { method: 'DELETE' },
    );
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`Failed to delete attachment: ${res.status}`);
  }

  async getAttachmentContent(sourceId: string, attachmentId: string): Promise<{ contentBase64: string; contentType: string }> {
    const { listId, taskId } = parseSourceId(sourceId);
    const res = await this.client.graphFetch(
      `/me/todo/lists/${listId}/tasks/${taskId}/attachments/${attachmentId}`,
    );
    if (!res.ok) throw new Error(`Failed to get attachment content: ${res.status}`);
    const data = await res.json();
    return {
      contentBase64: data.contentBytes || '',
      contentType: data.contentType || 'application/octet-stream',
    };
  }

  /**
   * Add a cross-reference note to a Microsoft Todo task by appending it to the body.
   * MS Todo has no native comments, so we append a separator and the note to the task's body.
   */
  async addComment(sourceId: string, body: string): Promise<void> {
    const { listId, taskId } = parseSourceId(sourceId);
    const getRes = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}?$select=body`);
    if (!getRes.ok) throw new Error(`Failed to fetch task body: ${getRes.status}`);
    const data = await getRes.json();
    const currentContent: string = data.body?.content || '';
    const currentType: string = data.body?.contentType || 'text';
    const separator = currentContent ? '\n\n---\n' : '';
    const updatedContent = `${currentContent}${separator}${body}`;
    const patchRes = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: { content: updatedContent, contentType: currentType } }),
    });
    if (!patchRes.ok) throw new Error(`Failed to append comment to task: ${patchRes.status}`);
  }

  async addTagToTask(sourceId: string, tagName: string): Promise<void> {
    await this.addTagsToTask(sourceId, [tagName]);
  }

  async addTagsToTask(sourceId: string, tagNames: string[]): Promise<void> {
    if (!tagNames.length) return;
    const { listId, taskId } = parseSourceId(sourceId);
    const hashtags = tagNames.map(name => `#${name.replace(/\s+/g, '-')}`);
    const res = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}`);
    if (!res.ok) throw new Error(`Failed to fetch task for tag write-back: ${res.status}`);
    const data = await res.json();
    const currentTitle: string = data.title || '';
    const existingHashtags = new Set((currentTitle.match(/(?:^|\s)#(\w[\w-]*)/g) || []).map(m => m.trim().toLowerCase()));
    const newHashtags = hashtags.filter(h => !existingHashtags.has(h.toLowerCase()));
    if (!newHashtags.length) return;
    const updatedTitle = `${currentTitle} ${newHashtags.join(' ')}`;
    const patchRes = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ title: updatedTitle }) });
    if (!patchRes.ok) throw new Error(`Failed to write tags to task title: ${patchRes.status}`);
  }

  async removeTagFromTask(sourceId: string, tagName: string): Promise<void> {
    const { listId, taskId } = parseSourceId(sourceId);
    const hashtagSlug = tagName.replace(/\s+/g, '-');
    const res = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}`);
    if (!res.ok) throw new Error(`Failed to fetch task for tag removal: ${res.status}`);
    const data = await res.json();
    const currentTitle: string = data.title || '';
    const updatedTitle = currentTitle
      .replace(new RegExp(`\\s*#${hashtagSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '')
      .trim().replace(/\s{2,}/g, ' ');
    if (updatedTitle === currentTitle) return;
    const patchRes = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ title: updatedTitle }) });
    if (!patchRes.ok) throw new Error(`Failed to remove tag from task title: ${patchRes.status}`);
  }

  async renameList(sourceId: string, newName: string): Promise<void> {
    const res = await this.client.graphFetch(`/me/todo/lists/${encodeURIComponent(sourceId)}`, { method: 'PATCH', body: JSON.stringify({ displayName: newName }) });
    if (!res.ok) { const text = await res.text().catch(() => ''); throw new Error(`Failed to rename list: ${res.status} ${text}`); }
  }

  async createList(name: string): Promise<{ id: string; displayName: string }> {
    const { startsWithUnsafeEmoji } = await import('@/lib/validation/emoji-safety');
    if (startsWithUnsafeEmoji(name)) {
      throw new Error(`Cannot create list "${name}": name starts with an SMP emoji (U+10000+) which will be invisible to the Graph API. Use a BMP emoji (✅⚡⭐⚙️) or no emoji.`);
    }
    const res = await this.client.graphFetch('/me/todo/lists', { method: 'POST', body: JSON.stringify({ displayName: name }) });
    if (!res.ok) { const text = await res.text().catch(() => ''); throw new Error(`Failed to create list: ${res.status} ${text}`); }
    const data = await res.json();
    return { id: data.id, displayName: data.displayName };
  }

  async deleteList(sourceId: string): Promise<void> {
    const res = await this.client.graphFetch(`/me/todo/lists/${encodeURIComponent(sourceId)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) { const text = await res.text().catch(() => ''); throw new Error(`Failed to delete list: ${res.status} ${text}`); }
  }

  async moveTaskToList(sourceId: string, targetListSourceId: string): Promise<string> {
    const { listId, taskId } = parseSourceId(sourceId);
    const getRes = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}`);
    if (!getRes.ok) throw new Error(`Failed to read task: ${getRes.status}`);
    const taskData = await getRes.json();

    const newTaskBody: Record<string, unknown> = {};
    if (taskData.title) newTaskBody.title = taskData.title;
    if (taskData.body) newTaskBody.body = taskData.body;
    if (taskData.importance) newTaskBody.importance = taskData.importance;
    if (taskData.status) newTaskBody.status = taskData.status;
    if (taskData.dueDateTime) newTaskBody.dueDateTime = taskData.dueDateTime;
    if (taskData.reminderDateTime) newTaskBody.reminderDateTime = taskData.reminderDateTime;
    if (taskData.completedDateTime) newTaskBody.completedDateTime = taskData.completedDateTime;
    if (taskData.recurrence) newTaskBody.recurrence = taskData.recurrence;
    if (taskData.isReminderOn != null) newTaskBody.isReminderOn = taskData.isReminderOn;
    if (taskData.categories) newTaskBody.categories = taskData.categories;

    const createRes = await this.client.graphFetch(`/me/todo/lists/${targetListSourceId}/tasks`, { method: 'POST', body: JSON.stringify(newTaskBody) });
    if (!createRes.ok) throw new Error(`Failed to create task in target: ${createRes.status}`);
    const created = await createRes.json();

    const delRes = await this.client.graphFetch(`/me/todo/lists/${listId}/tasks/${taskId}`, { method: 'DELETE' });
    if (!delRes.ok) connectorLogger.warn({ status: delRes.status }, 'Failed to delete task from source list after move');

    return `${targetListSourceId}:${created.id}`;
  }

  async setMyDay(sourceId: string, isInMyDay: boolean): Promise<void> {
    const { listId, taskId } = parseSourceId(sourceId);
    const today = getLocalToday() + 'T00:00:00Z';

    try {
      const res = await this.client.substrateFetch(`/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ CommittedDay: isInMyDay ? today : null }) });
      if (res.ok) return;
    } catch (err) {
      connectorLogger.warn({ err }, 'Substrate setMyDay failed, falling back to Graph beta');
    }

    const res = await this.client.graphBetaFetch(`/me/todo/lists/${listId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ isInMyDay }) });
    if (!res.ok) throw new Error(`Failed to set My Day: ${res.status}`);
  }

  async fetchMyDayTasks(date?: string): Promise<SubstrateMyDayTask[]> {
    const queryDate = date || getLocalToday();
    const res = await this.client.substrateFetch(`/myDayFeed/sections/tasks?date=${queryDate}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.Value || data.value || [];
  }

  async fetchMyDaySuggestions(): Promise<SubstrateMyDayTask[]> {
    const res = await this.client.substrateFetch('/myDayFeed/sections/suggestedTasks');
    if (!res.ok) return [];
    const data = await res.json();
    return data.Value || [];
  }

  async getLastSyncToken(): Promise<string | null> { return this.deltaToken; }

  // ─── Private helpers ──────────────────────────────────────────────────

  private async getListsToSync(): Promise<GraphTodoList[]> {
    let allLists: GraphTodoList[] = [];
    let url = '/me/todo/lists?$top=100';
    while (url) {
      const res = await this.client.graphFetch(url);
      if (!res.ok) throw new Error(`Failed to fetch lists: ${res.status}`);
      const data = await res.json();
      allLists = allLists.concat(data.value || []);
      url = data['@odata.nextLink'] ? data['@odata.nextLink'].replace(GRAPH_BASE_URL, '') : '';
    }

    if (allLists.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const retryRes = await this.client.graphFetch('/me/todo/lists?$top=100');
      if (retryRes.ok) { allLists = (await retryRes.json()).value || []; }
    }

    const syncedIds = this.config?.syncedLists || [];
    if (syncedIds.length === 0) return allLists;
    return allLists.filter((list: GraphTodoList) => syncedIds.includes(list.id));
  }

  private async getDefaultListId(): Promise<string> {
    const lists = await this.getListsToSync();
    return lists[0]?.id || 'defaultList';
  }

  private async *fetchTasksFromList(
    listId: string,
    listName: string,
    since?: Date,
    wellKnownListName?: string,
  ): AsyncGenerator<TaskItem[], void, unknown> {
    const passes = since
      ? [`/me/todo/lists/${listId}/tasks?$top=100&$expand=checklistItems,linkedResources&$filter=lastModifiedDateTime ge ${since.toISOString()}`]
      : [
          `/me/todo/lists/${listId}/tasks?$top=100&$expand=checklistItems,linkedResources`,
          `/me/todo/lists/${listId}/tasks?$top=100&$expand=checklistItems,linkedResources&$filter=status eq 'completed'`,
        ];
    const recurringTasks: TaskItem[] = [];
    const recentCompletedRecurring = new Map<string, { completedAt: string; sourceId: string }>();
    const nearestOpenRecurring = new Map<string, { dueDate: string | null; updatedAt: string; sourceId: string }>();

    for (const startUrl of passes) {
      const isCompletedPass = startUrl.includes("status eq 'completed'");
      let url: string = startUrl;

      while (url) {
        const res = await this.client.graphFetch(url);
        if (!res.ok) {
          if (url.includes("status eq 'completed'") && res.status === 400) break;
          throw new Error(`Failed to fetch tasks from list ${listId}: ${res.status}`);
        }
        const data = await res.json();
        const pageTasks: TaskItem[] = [];

        for (const graphTask of data.value || []) {
          if (
            wellKnownListName === 'flaggedEmails'
            && (!Array.isArray(graphTask.linkedResources) || graphTask.linkedResources.length === 0)
          ) {
            graphTask.linkedResources = await this.fetchLinkedResources(
              listId,
              graphTask.id,
              graphTask.linkedResources,
            );
          }

          if (isCompletedPass && graphTask.recurrence && graphTask.status === 'completed') {
            const titleKey = (graphTask.title || '').trim().toLowerCase();
            const completedAt = graphTask.completedDateTime?.dateTime || graphTask.lastModifiedDateTime || '';
            const sourceId = `${listId}:${graphTask.id}`;
            const existing = recentCompletedRecurring.get(titleKey);
            if (existing && existing.completedAt >= completedAt) continue;
            if (existing) {
              removeBufferedRecurringTask(recurringTasks, existing.sourceId);
            }
            recentCompletedRecurring.set(titleKey, { completedAt, sourceId });
          }

          if (graphTask.recurrence && graphTask.status !== 'completed') {
            const titleKey = (graphTask.title || '').trim().toLowerCase();
            const openKey = `${titleKey}::${listId}`;
            const dueDate = graphTask.dueDateTime?.dateTime?.slice(0, 10) || null;
            const updatedAt = graphTask.lastModifiedDateTime || graphTask.createdDateTime || '';
            const sourceId = `${listId}:${graphTask.id}`;
            const existing = nearestOpenRecurring.get(openKey);
            if (existing) {
              const existingBetter = compareRecurringOccurrencePriority(
                existing,
                { dueDate, updatedAt },
                getLocalToday(),
              ) <= 0;
              if (existingBetter) continue;
              removeBufferedRecurringTask(recurringTasks, existing.sourceId);
            }
            nearestOpenRecurring.set(openKey, { dueDate, updatedAt, sourceId });
          }

          const task = mapGraphTask(graphTask, listId, listName, this.type, this.id, wellKnownListName);
          let checklistItems = (graphTask.checklistItems || []) as GraphChecklistItem[];

          // Graph API can omit checklistItems when $filter is combined with $expand.
          // If the task reportedly has checklist items but expansion returned none,
          // fetch them in a dedicated request as a fallback.
          if (checklistItems.length === 0 && since) {
            try {
              const clRes = await this.client.graphFetch(
                `/me/todo/lists/${listId}/tasks/${graphTask.id}/checklistItems`
              );
              if (clRes.ok) {
                const clData = await clRes.json();
                checklistItems = (clData.value || []) as GraphChecklistItem[];
              }
            } catch {
              // Non-fatal: checklist items will sync on next full sync
            }
          }

          const checklistTasks = checklistItems.map(item =>
            mapChecklistItem(item, listId, graphTask.id, task.id, this.type, this.id, graphTask.createdDateTime)
          );

          if (!graphTask.recurrence) {
            pageTasks.push(task, ...checklistTasks);
            continue;
          }
          recurringTasks.push(task, ...checklistTasks);
        }

        url = data['@odata.nextLink'] ? data['@odata.nextLink'].replace(GRAPH_BASE_URL, '') : '';
        yield pageTasks;
      }
    }

    if (recurringTasks.length > 0) {
      yield recurringTasks;
    }
  }

  private async fetchLinkedResources(
    listId: string,
    taskId: string,
    expandedResources: GraphLinkedResource[] | undefined,
  ): Promise<GraphLinkedResource[]> {
    const resources = [...(expandedResources ?? [])];
    let url = `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/linkedResources`;

    while (url) {
      let response: Response;
      try {
        response = await this.client.graphFetch(url);
      } catch (error) {
        connectorLogger.warn({ err: error, listId, taskId }, 'Failed to fetch flagged email linked resources');
        return resources;
      }
      if (!response.ok) {
        connectorLogger.warn(
          { status: response.status, listId, taskId },
          'Failed to fetch flagged email linked resources',
        );
        return resources;
      }

      const data = await response.json() as {
        value?: GraphLinkedResource[];
        '@odata.nextLink'?: string;
      };
      resources.push(...(data.value ?? []));
      url = data['@odata.nextLink']?.replace(GRAPH_BASE_URL, '') ?? '';
    }

    return resources;
  }

  private async *fetchTasksFromHiddenLists(
    graphListIds: Set<string>,
    since?: Date,
  ): AsyncGenerator<TaskItem[], void, unknown> {
    const folderNameCache = new Map<string, string>();
    const substratePasses = ['/tasks?$top=500', "/tasks?$top=500&$filter=Status eq 'Completed'"];

    for (const startUrl of substratePasses) {
      let taskUrl: string | null = startUrl;
      let pages = 0;
      while (taskUrl && pages < 50) {
        pages++;
        const res = await this.client.substrateFetch(taskUrl);
        if (!res.ok) break;
        const data = await res.json();
        const tasks = data.value || data.Value || [];
        if (tasks.length === 0) break;
        const pageTasks: TaskItem[] = [];

        for (const subTask of tasks) {
          const folderId = subTask.ParentFolderId;
          if (!folderId || graphListIds.has(folderId)) continue;
          if (since && subTask.LastModifiedDateTime) {
            if (new Date(subTask.LastModifiedDateTime) < since) continue;
          }

          if (!folderNameCache.has(folderId)) {
            folderNameCache.set(folderId, await this.resolveHiddenFolderName(folderId));
          }

          pageTasks.push(mapSubstrateTask(subTask, folderId, folderNameCache.get(folderId) || '[Hidden List]', this.type, this.id));
        }

        const nextLink = data['@odata.nextLink'] || data['@nextLink'] || '';
        taskUrl = nextLink ? nextLink.replace(SUBSTRATE_BASE_URL, '') : '';
        yield pageTasks;
      }
    }
  }

  private async resolveHiddenFolderName(folderId: string): Promise<string> {
    try {
      const res = await this.client.substrateFetch(`/taskfolders/${folderId}`);
      if (res.ok) {
        const data = await res.json();
        return data.Name || data.name || data.DisplayName || data.displayName || '[Hidden List]';
      }
    } catch { /* ignore */ }
    return '[Hidden List]';
  }

  private buildRecurrencePattern(pattern: string, startDate?: string) {
    const start = startDate || getLocalToday();
    return buildMicrosoftRecurrencePattern(pattern, start);
  }
}

export function buildMicrosoftRecurrencePattern(pattern: string, start: string) {
    const base = { range: { type: 'noEnd', startDate: start } };
    const [year, month, day] = start.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, month - 1, day));
    const getDayName = () => {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      return days[startDate.getUTCDay()];
    };
    switch (pattern) {
      case 'daily': return { ...base, pattern: { type: 'daily', interval: 1 } };
      case 'weekdays': return { ...base, pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] } };
      case 'weekly': return { ...base, pattern: { type: 'weekly', interval: 1, daysOfWeek: [getDayName()] } };
      case 'biweekly': return { ...base, pattern: { type: 'weekly', interval: 2, daysOfWeek: [getDayName()] } };
      case 'monthly': return { ...base, pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: day } };
      case 'yearly': return { ...base, pattern: { type: 'absoluteYearly', interval: 1, dayOfMonth: day, month } };
      default: {
        const intervalMatch = pattern.match(/^every (\d+) (days?|weeks?|months?|years?)$/i);
        if (intervalMatch) {
          const interval = Number(intervalMatch[1]);
          const unit = intervalMatch[2].toLowerCase().replace(/s$/, '');
          if (unit === 'day') return { ...base, pattern: { type: 'daily', interval } };
          if (unit === 'week') {
            return {
              ...base,
              pattern: { type: 'weekly', interval, daysOfWeek: [getDayName()] },
            };
          }
          if (unit === 'month') {
            return {
              ...base,
              pattern: { type: 'absoluteMonthly', interval, dayOfMonth: day },
            };
          }
          return {
            ...base,
            pattern: {
              type: 'absoluteYearly',
              interval,
              dayOfMonth: day,
              month,
            },
          };
        }

        const weeklyDaysMatch = pattern.match(/^(?:weekly|every (\d+) weeks?) \(([^)]+)\)$/i);
        if (weeklyDaysMatch) {
          const interval = weeklyDaysMatch[1] ? Number(weeklyDaysMatch[1]) : 1;
          const daysOfWeek = weeklyDaysMatch[2]
            .split(',')
            .map((day) => day.trim().toLowerCase());
          return { ...base, pattern: { type: 'weekly', interval, daysOfWeek } };
        }

        return undefined;
      }
    }
}

// ─── Factory ─────────────────────────────────────────────────────────

export const microsoftTodoFactory: ConnectorFactory = {
  create: () => new MicrosoftTodoConnector(),
};
