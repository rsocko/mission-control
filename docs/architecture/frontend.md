---
title: "Frontend Architecture"
status: active
created: 2026-06-15
last_reviewed: 2026-07-30
category: architecture
related:
  - "[Architecture Overview](OVERVIEW.md)"
  - "[Design System](../reference/DESIGN-SYSTEM.md)"
---

# Frontend — Detail Architecture

> Next.js App Router with React components, dark-first design.

---

## Page Structure

```mermaid
graph TB
  subgraph Layout["Root Layout"]
    Sidebar["Sidebar<br/>Navigation"]
    Main["Main Content Area"]
    Providers["Providers<br/>(Theme, Toast, AI)"]
  end

  subgraph Pages["App Router Pages"]
    Today["/today — My Day"]
    AllTasks["/all-tasks — All Tasks"]
    Projects["/projects — Hub Projects"]
    Goals["/goals — Goals & Ideas"]
    Kanban["/kanban — Board View"]
    Timeline["/timeline — Timeline"]
    Triage["/triage — Triage Queue"]
    QuickSort["/quick-sort — Quick Sort"]
    Routines["/routines — Habits"]
    Insights["/insights — Insights"]
    Notifications["/notifications — Notification Center"]
    DocIntel["/doc-intelligence — Document Intelligence"]
    Capture["/capture — Quick Capture"]
    Intake["/intake — Intake Processing"]
    Settings["/settings — Config"]
  end

  Layout --> Pages

  classDef layout fill:#111827,stroke:#10b981,color:#f8fafc
  classDef page fill:#1e293b,stroke:#3b82f6,color:#f8fafc

  class Sidebar,Main,Providers layout
  class Today,AllTasks,Projects,Goals,Kanban,Timeline,Triage,QuickSort,Routines,Insights,Notifications,DocIntel,Capture,Intake,Settings page
```

---

## Component Hierarchy

```mermaid
graph TB
  subgraph Shell["Application Shell"]
    Sidebar["Sidebar<br/>nav, source lists, projects"]
    Toolbar["Toolbar<br/>search, filters, bulk actions"]
    Notifications["Notifications Panel<br/>real-time notifications"]
  end

  subgraph TaskViews["Task Views"]
    TaskList["TaskList<br/>sortable, grouped"]
    TaskDetail["TaskDetail<br/>slide-over panel"]
    KanbanBoard["KanbanBoard<br/>drag & drop columns"]
  end

  subgraph Shared["Shared Components"]
    AddTask["AddTask<br/>quick-add, NLP parsing"]
    PriorityBadge["PriorityBadge"]
    SmartScore["SmartScore indicator"]
    DailyCounter["DailyCompletionCounter"]
    SearchDialog["Command Palette (Ctrl+K)<br/>search and task creation"]
  end

  subgraph AI["AI Components"]
    AIChat["AI Chat dialog"]
    BackgroundToast["Background AI toast"]
    TriageSuggestions["Triage suggestions"]
  end

  Shell --> TaskViews
  Shell --> Shared
  Shell --> AI

  classDef shell fill:#111827,stroke:#f59e0b,color:#f8fafc
  classDef views fill:#111827,stroke:#3b82f6,color:#f8fafc
  classDef shared fill:#1e293b,stroke:#10b981,color:#f8fafc
  classDef ai fill:#1e293b,stroke:#a855f7,color:#f8fafc

  class Sidebar,Toolbar,Notifications shell
  class TaskList,TaskDetail,KanbanBoard views
  class AddTask,PriorityBadge,SmartScore,DailyCounter,SearchDialog shared
  class AIChat,BackgroundToast,TriageSuggestions ai
```

---

## Client State Management

| Concern | Approach |
|---------|----------|
| Server data | React Server Components + fetch |
| Client data fetching | React Query (TanStack Query) |
| View preferences | Zustand stores (dashboard view) |
| Optimistic updates | Immediate UI → confirm on response |
| Real-time | Sync Event Bus → revalidation |
| Forms | React Hook Form (where needed) |

---

## Key UI Patterns

- **Dark-first** — Slate color scale, surface layering for depth
- **Dense information** — tight typography, minimal whitespace
- **Keyboard-driven** — Ctrl+K palette, shortcuts for common actions
- **Shared task parsing** — Quick Add and Ctrl+K creation use the same date, tag, priority, effort, and project grammar
- **Source indicators** — colored icons show data provenance
- **Skeleton loading** — no spinners, placeholder shapes during fetch
- **PWA** — Service Worker (Serwist) for offline support
- **Share Target** — Web Share Target API for receiving shared content
- **Push Notifications** — Web Push (VAPID) for timed reminders and nudges
