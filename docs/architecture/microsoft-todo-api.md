---
title: "Microsoft To Do Substrate API"
status: active
created: 2026-07-01
last_reviewed: 2026-07-30
category: reference
related:
  - "[Task Sync Integration](TASK-SYNC-INTEGRATION.md)"
  - "[Connectors](../architecture/CONNECTORS.md)"
---

# Microsoft To Do — Substrate API (Undocumented / Reverse-Engineered)

> **⚠️ WARNING**: This document describes **undocumented, reverse-engineered APIs** that are NOT part of the official Microsoft Graph API. These endpoints were discovered by analyzing the Microsoft To Do web application's network traffic (to.do.microsoft.com). They may change or break without notice.

> **Last verified**: July 2026 (To Do web app version 2.133.1)

---

## Table of Contents

1. [Background & Motivation](#background--motivation)
2. [The Three Data Partitions](#the-three-data-partitions)
3. [Substrate API Overview](#substrate-api-overview)
4. [Authentication](#authentication)
5. [Key Endpoints](#key-endpoints)
6. [The Critical Discovery: Graph API Pagination & UTF-16 Surrogate Pair Bug](#the-critical-discovery-graph-api-pagination--utf-16-surrogate-pair-bug)
7. [Folder Groups](#folder-groups)
8. [Task Fetching Strategy](#task-fetching-strategy)
9. [How the To Do Web App Works](#how-the-to-do-web-app-works)
10. [Multi-Account Aggregation](#multi-account-aggregation)
11. [ID Format Reference](#id-format-reference)
12. [Risk Assessment & Mitigations](#risk-assessment--mitigations)

---

## Background & Motivation

Mission Control syncs tasks from Microsoft To Do. The official **Microsoft Graph API** (`/me/todo/lists`) only returns a subset of lists — specifically, it omits lists whose `displayName` starts with any Supplementary Multilingual Plane (SMP) emoji (`U+10000` and above). BMP emoji (`U+FFFF` and below) remain visible. This is a confirmed bug in the Graph API listing endpoint (see [Root Cause Analysis](#the-critical-discovery-graph-api-pagination--utf-16-surrogate-pair-bug) below).

In our case, Graph API returned **55 lists** while the user had **96+ lists** visible in the To Do web app. The missing ~41 lists all had names starting with SMP emoji (📘, 📺, 🚗, 🛁, etc.).

The official Graph API provides no mechanism to access these lists. After exhaustive testing and a controlled rename experiment that proved the UTF-16 surrogate pair bug, we reverse-engineered the To Do web app's network traffic to discover the Substrate API approach that returns all lists regardless of naming.

---

## The Three Data Partitions

Microsoft To Do tasks live across multiple storage backends:

| Partition | ID Format | API Access | Lists Returned |
|-----------|-----------|------------|----------------|
| **Graph Todo** | `AQMkADAwATNiZmYA...` | Graph API `/me/todo/lists` | ~55 (excludes lists with SMP emoji names) |
| **Substrate (personal)** | Same `AQMk...` format | `substrate.office.com/todob2/api/v1/taskfolders` | 46 (default pagination) or **96** (with `maxpagesize=200`) |
| **Substrate (work/school)** | `AAMkADgz...` (EWS format) | Same Substrate endpoint, different auth token | Varies (linked work account) |

### Key Insight
The same Substrate endpoint returns **dramatically different results** depending on query parameters. Without the `AllExtensions` select parameter, Substrate hides Wunderlist-migrated folders. This is the central discovery documented here.

---

## Substrate API Overview

**Base URL**: `https://substrate.office.com/todob2/api/v1`

This is Microsoft's internal "Substrate" platform — a backend service layer that powers Office 365 apps. It's NOT part of the public Microsoft Graph API and has no official documentation.

The To Do web app (to.do.microsoft.com) uses Substrate as its primary backend instead of Graph API. Graph API appears to be a public facade over a subset of Substrate's functionality.

---

## Authentication

Substrate uses the same OAuth2 bearer tokens as Graph API, but requires a **different token audience**:

```
Token endpoint: https://login.microsoftonline.com/common/oauth2/v2.0/token
```

In our implementation, we store two tokens:
- `accessToken` — Standard Graph API token (audience: `https://graph.microsoft.com`)
- `substrateToken` — Substrate token (audience: `https://substrate.office.com`)

Both are obtained during the same OAuth flow but with different scopes/resources. The Substrate token is obtained by requesting the `https://substrate.office.com/.default` scope.

**Important**: The `substrateToken` and `accessToken` use the SAME refresh token. When refreshing, request both audiences.

### Headers Required

```http
Authorization: Bearer {substrateToken}
Content-Type: application/json
```

No additional headers (like `x-anchormailbox`) appear to be required for personal account access, though the web app does send several optional telemetry/routing headers.

---

## Key Endpoints

### 1. List All Task Folders (THE CRITICAL ENDPOINT)

```
GET /taskfolders?$select=*,AllExtensions/Com_Wunderlist_Import,AllExtensions/com_microsoft_uno&maxpagesize=200
```

**This is the most important endpoint.** The critical parameter is `maxpagesize=200`. Without it, the default page size is ~50 and the API returns a `DeltaLink` (not a `nextLink`) making it appear that all results have been returned when they haven't.

The `AllExtensions` select parameters are used by the To Do web app and ensure all metadata is returned, but our testing shows **`maxpagesize=200` alone is sufficient** to get all folders.

#### Response Shape

```json
{
  "value": [
    {
      "Id": "AQMkADAwATNiZmYAZC04MDMzAC1mYzQwLTAwAi0wMAoA...",
      "Name": "📺Family Room / TV Room",
      "ChangeKey": "<synthetic-change-key>",
      "IsDefaultFolder": false,
      "IsSharedFolder": false,
      "IsOwner": true,
      "CreatedWithLocalId": null,
      "OrderDateTime": "2020-10-15T01:23:45Z",
      "SharingLink": null,
      "ShowCompletedTasks": true,
      "SortAscending": true,
      "SortType": "Manual",
      "ThemeBackground": null,
      "ThemeColor": null,
      "ExcludeFromSuggestions": false,
      "FolderType": "Normal",
      "SyncStatus": null,
      "SharingStatus": "NotShared",
      "ParentFolderGroupId": "RgAAAAAzavrc76VPTpNwfCTjDCjZBwBaYC0NI3eSR6J7LHAex-BwAAKDSOMoAABaYC0NI3eSR6J7LHAex-BwAANGo4FjAAAA0"
    }
  ]
}
```

#### Critical Fields

| Field | Description |
|-------|-------------|
| `Id` | Unique folder identifier (same format as Graph API list IDs) |
| `Name` | Display name (includes emoji if user added one) |
| `ParentFolderGroupId` | Links this folder to a folder group (see below) |
| `IsDefaultFolder` | True for the built-in "Tasks" list |
| `FolderType` | "Normal", "Flagged", etc. |
| `IsSharedFolder` / `IsOwner` | Sharing metadata |

### 2. Folder Groups

```
GET /foldergroups
```

Returns the user's list group hierarchy (what you see as collapsible sections in the To Do sidebar).

#### Response Shape

```json
{
  "value": [
    {
      "Id": "RgAAAAAzavrc76VPTpNwfCTjDCjZBwBaYC0NI3eSR6J7LHAex-BwAAKDSOMoAABaYC0NI3eSR6J7LHAex-BwAANGo4FjAAAA0",
      "OrderDateTime": "2020-05-02T14:11:14Z",
      "Name": "🏠Home"
    }
  ]
}
```

#### Relationship
- `taskfolder.ParentFolderGroupId` → `foldergroup.Id`
- Not all folders have a `ParentFolderGroupId` (ungrouped lists)

### 3. Folder Groups with Delta

```
GET /foldergroups?deltaToken={token}&maxPageSize=50
```

Supports delta sync — returns only groups changed since the delta token was issued.

### 4. Task Folders with Delta

```
GET /taskfolders?deltatoken={token}&maxPageSize=200&$select=*,AllExtensions/Com_Wunderlist_Import,AllExtensions/com_microsoft_uno
```

### 5. Tasks within a Folder

```
GET /taskfolders/{folderId}/tasks?$expand=LinkedEntity&$select=*,AllExtensions/com_microsoft_uno_richplannertask&maxpagesize=50
```

#### Response Shape (task)

```json
{
  "Id": "AAMkADgz...",
  "Subject": "Task title",
  "Status": "NotStarted",
  "Importance": "Normal",
  "DueDateTime": { "DateTime": "2026-07-15T00:00:00Z", "TimeZone": "UTC" },
  "CompletedDateTime": null,
  "CreatedDateTime": "2026-01-15T12:00:00Z",
  "LastModifiedDateTime": "2026-07-01T08:30:00Z",
  "ParentFolderId": "AQMk...",
  "Categories": ["Category1"],
  "Body": { "ContentType": "Text", "Content": "Notes here" },
  "Recurrence": null,
  "CommittedDay": null,
  "CommittedOrder": null
}
```

### 6. All Tasks (flat, across all folders)

```
GET /tasks?$top=500
GET /tasks?$top=500&$filter=Status eq 'Completed'
```

Returns tasks across all folders. Each task has a `ParentFolderId` for grouping.

### 7. My Day Feed

```
GET /myDayFeed/sections/tasks
GET /myDayFeed/sections/suggestedTasks
```

### 8. Capabilities & Settings

```
GET /capabilities
GET /settings
GET /mastercategories
```

---

## The Critical Discovery: Graph API Pagination & UTF-16 Surrogate Pair Bug

### The Problem (Two Issues)

**Issue 1: Graph API `/me/todo/lists` silently excludes lists**

The Microsoft Graph API listing endpoint returns only a subset of the user's lists:
- Returns: 55 lists
- Missing: 41 lists
- No `@odata.nextLink` provided — claims this IS the full set

**Issue 2: Substrate default pagination is misleading**

```
GET /taskfolders          → Returns 46 folders + DeltaLink (NO nextLink)
GET /taskfolders?maxpagesize=200  → Returns ALL 96 folders
```

Without `maxpagesize=200`, Substrate returns a partial page and a `DeltaLink`, making it appear that all results have been returned.

### Root Cause: Graph API UTF-16 Surrogate Pair Bug

Through controlled experimentation (July 2026), we definitively proved that the Graph API `/me/todo/lists` endpoint **excludes lists whose `displayName` starts with any SMP emoji (`U+10000+`)**.

#### The Experiment

| Step | Action | Graph Lists | "🥾Mudroom" in listing? |
|------|--------|-------------|------------------------|
| 1 | Baseline (name: "🥾Mudroom") | 55 | ❌ No |
| 2 | PATCH rename to "Mudroom" | 55 | ✅ **YES — appeared!** |
| 3 | PATCH rename back to "🥾Mudroom" | 55 | ❌ **Disappeared again** |

This proves:
- The list is **fully accessible** individually (`GET /me/todo/lists/{id}` → 200 OK)
- The list can be **renamed via PATCH** (200 OK)
- The **listing endpoint** actively filters based on the display name's first character
- **Removing the emoji makes it visible; restoring it hides it again**

#### The Unicode Boundary

| Category | Unicode Range | Graph Listing |
|----------|--------------|---------------|
| ASCII text (A-Z, a-z) | U+0041–U+007A | ✅ Always visible |
| BMP emoji / symbols (✅, ⚡, ☀️, ⭐, ❤️) | U+0000–U+FFFF | ✅ Visible |
| SMP emoji (💯, 💰, 📎, 🔥, 📘) | U+10000–U+10FFFF | ❌ **EXCLUDED** |

**Safe boundary**: BMP (`U+FFFF` and below)  
**Hidden boundary**: SMP (`U+10000` and above)

This matches UTF-16 encoding behavior exactly:
- **BMP codepoints** fit in a single UTF-16 code unit (`char` in .NET)
- **SMP codepoints** require a **surrogate pair** (two UTF-16 code units)

The most likely backend bug is that Microsoft's listing/indexing code reads the first "character" as a single UTF-16 `char`, which works for BMP emoji but mis-handles SMP emoji because the first visible symbol is actually stored as a high-surrogate + low-surrogate pair.

#### Confirmed Test Results

| Prefix | Codepoint | Plane | UTF-16 | Result |
|--------|-----------|-------|--------|--------|
| ✅ | U+2705 | BMP | Single code unit | ✅ Visible |
| 💯 | U+1F4AF | SMP | Surrogate pair | ❌ Hidden |
| 💰 | U+1F4B0 | SMP | Surrogate pair | ❌ Hidden |
| 📎 | U+1F4CE | SMP | Surrogate pair | ❌ Hidden |
| 🔥 | U+1F525 | SMP | Surrogate pair | ❌ Hidden |

#### Safe Emoji Alternatives for Users

Because most "object" emoji live in the SMP and trigger the bug, the safest replacements are BMP symbols such as:

`✅ ⚡ ☀️ ⭐ ❤️ ♻️ ☑️ ⚙️ ✏️ ✂️ ☎️ ⌚ ⚠️ ♨️ ☘️ ♦️ ♠️ ♣️ ♥️ ✉️ ✒️`

#### Additional Correlations (NOT Causative)

| Factor | Graph-visible | Hidden | Notes |
|--------|--------------|--------|-------|
| Created 2018-2020 | 52/55 | 41/41 | Age is correlated but NOT the cause (rename test proves it) |
| IsSharedFolder=true | 13/55 | 1/41 | Shared lists are always visible regardless of emoji |
| IsOwner=false | 6/55 | 0/41 | Lists shared TO you are always visible |
| All metadata fields identical | ✓ | ✓ | No other distinguishing field |
| ID format identical | ✓ | ✓ | Same `AQMk...` prefix, same length |
| SyncStatus=Synced | 55/55 | 41/41 | No status difference |

#### Most Likely Internal Mechanism

The strongest current explanation is a UTF-16 surrogate-pair bug in the Graph list enumeration path:
1. The backend inspects or indexes the first character of `displayName`
2. That code path appears to assume one UTF-16 `char` = one Unicode character
3. BMP prefixes work because they fit in one code unit
4. SMP emoji fail because they are represented as two code units (high surrogate + low surrogate)
5. The individual list endpoints and PATCH rename path do not share this bug, so direct access still works

### Why This Is a Bug Worth Reporting

1. **Silently loses data**: No error, no indication of missing items
2. **No `@odata.nextLink`**: Makes it impossible for apps to know they have incomplete data
3. **Individual access works**: `GET /me/todo/lists/{id}` returns 200 for "missing" lists
4. **PATCH works**: You can rename, confirming full read/write access
5. **Scope**: Affects ANY third-party app using the official Graph API
6. **No workaround via public API**: Must use undocumented Substrate endpoint

### Microsoft Bug Report Template

```
Title: Graph API /me/todo/lists omits lists whose displayName starts with SMP emoji (UTF-16 surrogate pairs)

Severity: Data Loss (silent)
API: Microsoft Graph v1.0 and beta
Endpoint: GET /me/todo/lists

Description:
The listing endpoint silently omits lists whose displayName begins with
SMP emoji (Unicode U+10000 and above). These lists are fully
accessible individually (GET /me/todo/lists/{id} returns 200) and can be
modified (PATCH returns 200), but do not appear in enumeration.

Reproduction:
1. Create a list named "Test List" → appears in listing
2. Rename to "💯Test List" (U+1F4AF, surrogate pair prefix) → disappears from listing
3. GET /me/todo/lists/{id} still returns 200
4. Rename back to "Test List" → reappears in listing

Impact: ~40% of lists invisible to third-party apps using official API.
No @odata.nextLink provided, so apps cannot detect incomplete results.

Workaround: Use Substrate API (/todob2/api/v1/taskfolders?maxpagesize=200)
which returns all lists regardless of name encoding.
```

---

## Folder Groups

### How Folder Groups Work

1. **Fetch groups**: `GET /foldergroups` → array of `{Id, Name, OrderDateTime}`
2. **Each folder has**: `ParentFolderGroupId` linking to its parent group
3. **Ungrouped folders**: Have `ParentFolderGroupId: null` or missing

### Our Implementation

During sync, we:
1. Call `/foldergroups` to get group metadata
2. Call `/taskfolders?$select=*,AllExtensions/...` to get all folders with their `ParentFolderGroupId`
3. Auto-create `list_groups` in our DB matching the Substrate group names
4. Auto-assign `source_lists.group_id` for lists that don't already have a manual assignment

This means the user's To Do folder organization is automatically mirrored in Mission Control.

---

## Task Fetching Strategy

### The To Do Web App's Approach

Based on network trace analysis, the web app uses a **different strategy** than fetching per-list:

1. Fetches tasks from **two aggregate folder IDs** using delta tokens:
   - Personal account folder: `AQMkADgz...AAM2AAAA` (starts with `AQMk`)
   - Work account folder: `AAMkADgz...AAF3vLL3AAA=` (starts with `AAMk`)
2. Paginates with `skiptoken` (50 items per page)
3. Groups tasks **client-side** by `ParentFolderId`
4. Also fetches individual folder tasks for non-delta scenarios

### Our Approach

We use a hybrid:
1. **List discovery**: Substrate `/taskfolders?$select=*,AllExtensions/...` (discovers ALL folders)
2. **Task fetching**: Graph API per-list `/me/todo/lists/{id}/tasks` (reliable, paginated)
3. **Hidden list tasks**: Graph API direct access `/me/todo/lists/{id}/tasks` (for lists not in Graph listing but individually accessible)
4. **Fallback**: Substrate `/taskfolders/{id}/tasks` (if Graph access fails for a specific list)

---

## How the To Do Web App Works

Based on the captured network trace (July 2026, app version 2.133.1):

### Startup Sequence

1. `GET /capabilities` — feature flags
2. `GET /settings` — user preferences
3. `GET /foldergroups` — group metadata (with delta)
4. `GET /taskfolders?$select=*,AllExtensions/Com_Wunderlist_Import,AllExtensions/com_microsoft_uno&maxpagesize=200` — ALL folders
5. `GET /taskfolders?deltatoken=...` — delta update for folders
6. `GET /mastercategories` — category/tag definitions
7. `GET /myDayFeed/sections/tasks` — My Day items
8. `GET /taskfolders/{id}/tasks` — Per-folder task fetching (parallelized, ~30-50 folders simultaneously)
9. Delta task fetching from aggregate folders with `deltatoken` and `skiptoken` pagination

### Key Observations

- The web app fires **all per-folder task requests in parallel** (not sequential)
- Uses `$expand=LinkedEntity` on task queries (for Planner/Loop integration)
- Uses `AllExtensions/com_microsoft_uno_richplannertask` select on tasks (Planner metadata)
- Supports both `deltatoken` (for incremental updates) and `skiptoken` (for pagination within a response)

---

## Multi-Account Aggregation

### Discovery

The To Do web app aggregates tasks from **multiple accounts** in a single view:

| Account Type | ID Prefix | Token Endpoint | Description |
|--------------|-----------|----------------|-------------|
| Personal (MSA) | `AQMk...` | `login.microsoftonline.com/common/oauth2/v2.0/token` | Consumer Microsoft account |
| Work/School (AAD) | `AAMk...` | `login.microsoftonline.com/organizations/oauth2/v2.0/token` | Azure AD / Entra ID account |

### Implications for Mission Control

- Our connector currently authenticates to **one account** (personal MSA)
- If a user has both personal and work accounts linked in To Do, some lists will be inaccessible
- The EWS-format IDs (`AAMk...`) require authentication to the work/school tenant
- **Future work**: Support adding a second connector instance for work accounts

### How To Do Links Accounts

The To Do web app appears to:
1. Authenticate to the primary account
2. Discover linked accounts via some internal API
3. Obtain separate tokens for each linked account
4. Fetch from all accounts' Substrate endpoints
5. Merge results client-side, using `ParentFolderId` to group tasks

---

## ID Format Reference

### Folder/List IDs

| Format | Source | Example Prefix |
|--------|--------|----------------|
| Graph Todo (personal) | `AQMkADAwATNiZmYAZC0...` | `AQMkADAwATNi` |
| Substrate (personal) | Same as Graph | `AQMkADAwATNi` |
| EWS/Exchange (work) | `AAMkADgzZDBlNGUx...` | `AAMkADgz` |
| Folder Group | `RgAAAAAzavrc76VPTp...` | `RgAAAAA` |

### Task IDs

| Format | Source | Example Prefix |
|--------|--------|----------------|
| Graph Todo task | `AQMkADAwATNiZmYAZC0...` (longer) | `AQMkADAwATNi` |
| EWS task | `AAMkADgzZDBlNGUx...` (longer) | `AAMkADgz` |

### Distinguishing IDs

- **Personal account items**: Start with `AQMk` (base64-encoded, contains `NiZmYA` segment)
- **Work/school account items**: Start with `AAMk` (base64-encoded, different structure)
- **Folder groups**: Start with `Rg` (base64-encoded, short)

---

## Risk Assessment & Mitigations

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Microsoft changes Substrate API | Medium | High | Graceful fallback to Graph API only |
| `maxpagesize` param stops working | Low | High | Fall back to pagination with DeltaLink following |
| Token audience changes | Low | High | Monitor auth failures, re-auth flow |
| Rate limiting / throttling | Low | Medium | Respect retry-after headers |
| Endpoint URL changes | Low | High | Centralized URL constants |
| Microsoft fixes the Graph emoji bug | Low (ideal) | Positive | Could remove Substrate dependency entirely |

### Mitigations Implemented

1. **Graceful degradation**: If Substrate calls fail, we fall back to:
   - Graph API listing (55 lists — partial but functional)
   - Task-scan discovery (finds folders by scanning tasks' `ParentFolderId`)
   
2. **Layered approach**: Phase 1 (Graph) always runs. Phase 2 (Substrate) is additive.

3. **Non-critical failures**: Substrate failures log warnings but don't block sync.

4. **Name resolution priority**: Graph API > Substrate (Graph names are authoritative).

---

## Code References

| File | Function | Purpose |
|------|----------|---------|
| `src/lib/connectors/microsoft-todo/index.ts` | `fetchSourceLists()` | Multi-phase list discovery |
| `src/lib/connectors/microsoft-todo/index.ts` | `fetchFolderGroups()` | Fetches `/foldergroups` endpoint |
| `src/lib/connectors/microsoft-todo/index.ts` | `substrateFetch()` | Substrate HTTP helper |
| `src/lib/sync/index.ts` | `autoAssignFolderGroups()` | Group auto-creation & assignment |
| `src/lib/sync/index.ts` | `upsertSourceLists()` | Persists discovered lists |

---

## Appendix: Network Trace Summary

Captured from `to.do.microsoft.com` on July 7, 2026:

- **Total requests**: ~300+ on page load
- **Substrate requests**: ~250 (task fetching dominates)
- **Parallel task fetches**: Up to 50 concurrent `/taskfolders/{id}/tasks` requests
- **Delta token usage**: Both folder listing and task listing support delta sync
- **Pagination**: `skiptoken` with `maxPageSize=50` for tasks, `maxpagesize=200` for folders
- **CDN**: App bundle served from `res.public.onecdn.static.microsoft/todo/`

### Captured Endpoint Categories

1. **Metadata**: `/capabilities`, `/settings`, `/mastercategories`
2. **Folder discovery**: `/taskfolders?$select=*,AllExtensions/...`, `/foldergroups`
3. **Task fetching**: `/taskfolders/{id}/tasks` (per-folder, parallelized)
4. **Delta sync**: Both folders and tasks support delta tokens
5. **My Day**: `/myDayFeed/sections/tasks`, `/myDayFeed/sections/suggestedTasks`
6. **Telemetry**: `browser.events.data.microsoft.com` (extensive)
