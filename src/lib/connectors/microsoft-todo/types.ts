// Graph API Types shared across the Microsoft Todo connector modules

export interface GraphTodoList {
  id: string;
  displayName: string;
  wellKnownListName?: 'none' | 'defaultList' | 'flaggedEmails' | string;
  isOwner: boolean;
  isShared: boolean;
  parentFolderGroupId?: string;
}

export interface GraphTodoTask {
  id: string;
  title: string;
  body?: { content: string; contentType: string };
  status: string;
  importance: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  completedDateTime?: { dateTime: string; timeZone: string };
  dueDateTime?: { dateTime: string; timeZone: string };
  categories?: string[];
  hasAttachments?: boolean;
  recurrence?: {
    pattern: {
      type: string;
      interval: number;
      daysOfWeek?: string[];
      dayOfMonth?: number;
      month?: number;
    };
    range: {
      type: string;
      startDate?: string;
      endDate?: string;
    };
  } | null;
}

export interface GraphChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
  createdDateTime?: string;
}

/** Task shape returned by the substrate myDayFeed endpoint */
export interface SubstrateMyDayTask {
  Id: string;
  Subject: string;
  Status: string;
  CommittedDay: string | null;
  CommittedOrder: string | null;
  ParentFolderId: string;
  DueDateTime: { DateTime: string; TimeZone: string } | null;
  Importance: string;
  Categories: string[];
  CreatedDateTime: string;
  LastModifiedDateTime: string;
  CompletedDateTime: string | null;
  IsIgnored: boolean;
  Recurrence?: {
    Pattern: { Type: string; Interval: number; DaysOfWeek?: string[] };
    Range: { Type: string; StartDate?: string; EndDate?: string };
  } | null;
}

export interface MicrosoftTodoConfig {
  clientId: string;
  tenantId: string;
  accessToken?: string;
  refreshToken?: string;
  syncedListIds?: string[];
}
