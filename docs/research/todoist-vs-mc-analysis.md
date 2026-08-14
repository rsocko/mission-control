# Todoist vs Mission Control — Feature Analysis & Inspiration

## Executive Summary

Todoist and MC have fundamentally different philosophies — Todoist is a **standalone task manager** designed for simplicity and ubiquitous capture, while MC is a **task aggregation command center** pulling from external sources. However, Todoist has many UX patterns and features worth learning from, particularly around **frictionless capture**, **inline actions**, **planning views**, and **gamification/momentum**.

---

## 1. Task Row Inline Actions (High Value — Adopt)

### What Todoist Does
On hover, each task row reveals quick-action icons *directly on the row*:
- 📅 **Date picker** — click to get a date popover without opening the task
- 💬 **Comment icon** — shows comment count; click to open comments inline
- ✏️ **Edit icon** — inline edit the task name without a detail panel
- Priority indicator shown via the color of the completion circle ring

### What MC Does Now
- Hover shows: **Snooze** button, **My Day** toggle
- Everything else requires **right-click context menu** or **clicking into the detail panel**

### Opportunity
Add more **inline row actions** visible on hover:
- **Due date quick-set** icon → small popover with Today/Tomorrow/Next Week/Pick Date
- **Comment/Note indicator** → if task has description or notes, show a comment icon with count
- **Priority quick-set** → click the existing priority badge to cycle or show a mini picker
- **Edit inline** → double-click task title to edit in place

This is the pattern you specifically called out from the screenshot — the edit (pencil), calendar, and comment icons appearing on the task row. This reduces the need to open context menus or detail panels for the most common operations.

---

## 2. Ramble Mode / Voice Capture (Medium-High Value — Consider)

### What Todoist Does
- **Ramble mode**: Press a button, speak freely about everything you need to do
- AI transcribes and **parses your stream-of-consciousness into individual tasks**
- Automatically assigns dates, priorities, and projects from context
- Mobile widget provides one-tap access to Ramble
- Also integrates with Siri, Alexa, Google Assistant for individual task voice capture

### What MC Has
- No voice input
- QuickAddBar with text-based NLP token parsing (`#project`, priority shortcuts)

### Opportunity
- A "brain dump" mode (voice or rapid text) that uses AI to parse a freeform block into structured tasks
- Could be text-first for MC's power-user audience: paste a paragraph → AI extracts tasks with suggested projects, priorities, due dates
- Voice could come later as a mobile PWA feature
- The core insight: **reducing the friction between thinking and capturing** — MC's QuickAdd is good but still requires structured input

---

## 3. Upcoming / Planning View with Drag & Drop (High Value — Adopt)

### What Todoist Does
- **Upcoming view**: Bird's-eye view of tasks across all future dates, up to 2 years ahead
- Three layouts: List, Board (day columns), Calendar (week/month grid)
- **Drag-and-drop rescheduling**: drag tasks between days to reschedule
- **"No date" sidebar**: unscheduled tasks that can be dragged onto calendar dates
- **"Busy dot"** indicators show which dates already have tasks when picking a date
- **Bulk reschedule**: "Reschedule" button for overdue tasks
- **Plan sidebar**: shows overdue + all-day + time-blocked + unscheduled with upcoming deadlines

### What MC Has
- **Today/My Day** with drag-and-drop reordering
- **Interactive Timeline** in Today view (time blocks)
- **Timeline page** exists but is separate from the main task flow
- No dedicated "upcoming week/month planner" with drag-to-reschedule

### Opportunity
- A **"Plan Ahead"** or **"Upcoming"** view where you can see the next 7-14 days as columns/rows
- Drag tasks between days to reschedule due dates
- "Unscheduled" sidebar showing tasks without due dates that you can drag into your week
- This is fundamentally about **planning your week** — a use case MC's Today view doesn't fully serve
- Could integrate with MC's existing calendar event data to show a unified view

---

## 4. Browser Extension — Full Task Manager (Medium Value — Consider)

### What Todoist Does
- **Quick Add from any page**: click extension or right-click → "Add to Todoist"
- Auto-captures page URL and title as the task
- **Full task management** in the extension popup: view Today tasks, check things off, browse projects
- Available for Chrome, Firefox, Safari
- Gmail integration: turn emails into tasks directly from the email interface

### What MC Has
- Browser extension focused on **Triage capture**: capture links/content from web pages into the triage queue

### Opportunity
Two extension modes or a richer single extension:
1. **Capture mode** (existing): capture content to triage queue
2. **Task mode** (new): Quick Add task, view Today/My Day tasks, complete tasks — all without leaving the current tab
- Could be a tabbed interface in the extension popup
- The Gmail/Outlook email → task flow is particularly valuable: "Create task from this email" button injected into the email UI

---

## 5. Due Date vs. Deadline (Separate Concepts) (Medium Value — Consider)

### What Todoist Does
- **Due date** = "when you plan to work on it" (scheduling)
- **Deadline** = "when it must be done" (hard deadline)
- These are **separate fields** on a task
- Calendar shows both: due date determines position, deadline shows as a chip/indicator
- This lets you schedule work earlier than the deadline without losing track of the actual deadline

### What MC Has
- Single `dueDate` field on tasks
- `scheduledDate` in TaskSchedule for Today/focus planning
- No concept of a separate hard deadline

### Opportunity
- MC already has `dueDate` and `scheduledDate` — this is conceptually similar
- Could surface `scheduledDate` as "Work on" date vs `dueDate` as "Due by" more explicitly in the UI
- Or: add a `deadline` field that's distinct from scheduling, with visual indicators when deadline is approaching regardless of scheduled date

---

## 6. Natural Language Input Depth (Medium Value — Enhance)

### What Todoist Does
- Industry-leading NLP: `tomorrow 3pm`, `every monday`, `in 2 weeks`, `next friday`
- Inline in task name field — highlights recognized dates with visual indicator
- Can dismiss detected date if it's actually part of the task title
- **Recurring dates** are incredibly deep: `every!` (completion-based) vs `every` (schedule-based), bounded recurrence (`every day from aug 3 until aug 20`), multi-day (`every mon, fri at 8pm`), holiday keywords

### What MC Has
- QuickAddBar `TokenInput` with hash-based tokens (`#project`, priority)
- No NLP date parsing in the task title itself
- Recurring tasks handled by source connectors (MS Todo manages recurrence)

### Opportunity
- **Smart date recognition** in QuickAdd: type "buy groceries tomorrow" → auto-detect "tomorrow" and set due date
- Visual highlight of detected dates in the input (like Todoist's inline indicators)
- Since MC delegates to source connectors for recurrence, this is mainly about the **capture experience**
- Could use AI to parse freeform input: "call dentist next tuesday morning p2" → title: "Call dentist", due: next Tuesday 9am, priority: high

---

## 7. Karma / Gamification & Streaks (Medium Value — MC Already Exploring)

### What Todoist Does
- **Karma points**: awarded for completions, on-time tasks, using features; deducted for overdue
- **Levels**: Beginner → Enlightenment (unlocks secret theme)
- **Daily/Weekly goals**: configurable task count targets
- **Streaks**: consecutive days/weeks meeting goals
- **Vacation Mode**: freeze streaks while away
- **Days Off**: mark non-working days
- **Celebration animations** (toggleable)
- Fully optional — can be disabled entirely

### What MC Has
- `DailyCompletionCounter` component (planned)
- `CompletionBurst` micro-animation on task completion
- `DopamineMenu` component
- `RecentWins` component
- Routines system with streaks (`WeeklyGrid`, `BehaviorHeatmap`, `CadenceInsightsView`)

### Assessment
MC is already heading in a strong direction here with routines + streaks. Key Todoist ideas to consider:
- **Vacation Mode** for streak preservation — essential to prevent discouragement
- **Days Off** — don't break streaks on weekends/designated off days
- **Opt-out granularity**: let users disable gamification entirely, not just hide it
- **Weekly goals** alongside daily — broader momentum tracking

---

## 8. Comments / Notes on Tasks (Medium-High Value — Consider)

### What Todoist Does
- **Threaded comments** on every task
- **File attachments** in comments (up to 25 MB)
- **Email-to-comment**: each task has a unique email address
- **@mention** collaborators
- Markdown formatting in comments
- Comment count shown on task row (the 💬 icon you noticed)

### What MC Has
- Task `description` field (single text block)
- No threaded comments, no comment count on rows
- No attachments on tasks

### Opportunity
- MC is primarily a personal tool, so full threaded comments may be over-engineering
- But a **notes/comments section** on tasks with multiple entries + timestamps would be valuable for:
  - Progress notes ("tried X, didn't work")
  - Links and references gathered during work
  - Quick thoughts to add context without overwriting the description
- **Comment count indicator** on task rows (the icon pattern you liked) — shows at a glance which tasks have notes attached

---

## 9. Filter Query Language (Low-Medium Value — MC Has Alternative)

### What Todoist Does
- Full query language: `today & @waiting`, `p1 & overdue`, `#Project & assigned to: me`
- **Filter Assist**: AI generates filter queries from natural language descriptions
- Saved filters appear as views in the sidebar

### What MC Has
- `SidebarFilters` component
- Tag-based filtering via `useDashboardViewStore` (priority, status, tag, groupBy)
- Toolbar filters for priority, status, groupBy
- `SearchCommand` (Ctrl+K)

### Assessment
MC's approach of interactive filter UI is more aligned with its power-user-dense design philosophy. The Todoist query language is powerful but has a learning curve. MC could consider:
- **AI filter assist**: "Show me overdue high-priority tasks not in any project" → auto-set filters
- **Saved filter presets** that persist in the sidebar (if not already)

---

## 10. Sections within Projects (Low-Medium Value — MC Has Phases)

### What Todoist Does
- Named sections divide a project into groups
- In board view, sections become Kanban columns
- In list view, sections become collapsible headers
- Tasks can be dragged between sections

### What MC Has
- **Phases** (ProjectPhase) — ordered phases with status, timeline, estimated days
- **Kanban columns** with WIP limits and status mapping
- Source list grouping

### Assessment
MC's phases are more sophisticated than Todoist's sections — they have lifecycle status, timeline, and ordering. Todoist's sections are simpler/more flexible for ad-hoc grouping. No action needed — MC's model is stronger here.

---

## 11. Outlook / Email Integration (High Value — Future Connector)

### What Todoist Does
- **Outlook Mail integration**: button injected directly into Outlook to create tasks from emails
- **Gmail integration**: same — button in Gmail UI to create tasks
- **Email-to-task**: forward any email to a Todoist address → becomes a task
- **Email-to-comment**: forward emails to task-specific addresses → becomes a comment

### What MC Has
- MS Todo connector (tasks sync)
- Triage capture from browser
- No direct email integration

### Opportunity
- **Outlook connector** that goes beyond tasks: detect emails that imply action items
- **Email-to-MC** address: forward emails → triage queue items or tasks
- The Triage system is already positioned for this — emails could be a new `TriageSourcePlatform`
- An Outlook add-in that lets you "Send to MC" directly from an email would be powerful

---

## 12. Mobile Widgets (Medium Value — Future/PWA)

### What Todoist Does
- **Today widget**: at-a-glance task list on home screen
- **Ramble widget**: one-tap voice capture
- **Quick Add widget**: one-tap to add a task
- **Android Quick Settings tile**: "Add Task" in notification shade
- **iOS app icon long-press**: quick shortcuts

### What MC Has
- PWA (service worker in `sw.ts`, `~offline` route)
- No native mobile app or widgets

### Opportunity
- If/when MC goes mobile-native, widgets are essential for a task manager
- PWA limitations mean true home screen widgets aren't available
- For now, focus on making the PWA's "Add to Home Screen" experience excellent
- Consider: a **companion mobile app** (React Native) with widget support, even if the full experience is web

---

## 13. Task Inline Editing (Medium Value — Enhance)

### What Todoist Does
- Click task name → edit inline, no modal or panel needed
- Tab/Shift+Tab to navigate between tasks while editing
- `Ctrl+Arrow` keys to indent/outdent, move tasks
- Edit mode preserves list context

### What MC Has
- Click task → opens TaskDetailPanel (side panel)
- No inline title editing on the task row itself

### Opportunity
- **Double-click to inline edit** task title without opening the detail panel
- Enter to save, Escape to cancel
- This reduces friction for quick renames — the detail panel is too heavy for just fixing a typo

---

## 14. Favorites / Pinning (Low Value — MC Has "My Day")

### What Todoist Does
- Star any project, label, or filter → pins it to the top of the sidebar
- Quick access without scrolling

### What MC Has
- My Day pinning for tasks
- Sidebar organization by view type

### Assessment
MC's sidebar is already well-organized. Could consider letting users **pin specific projects** to the top of the sidebar, but low priority.

---

## 15. Templates (MC Already Has)

### What Todoist Does
- Import from template gallery (`todoist.com/templates`)
- Export any project as a template
- Templates support relative due dates

### What MC Has
- `TaskTemplate` type with single + workflow templates
- `TemplatePicker`, `SaveTemplateModal`, `WorkflowApplyModal`
- Category system (development, home, 3d-printing, etc.)

### Assessment
MC is on par or ahead here. Consider:
- **Relative due dates** in templates (e.g., "3 days from template creation date")
- **Community/shared template gallery** in the future

---

## 16. Two-Way Calendar Sync (Medium-High Value — Future)

### What Todoist Does
- **Google Calendar**: two-way sync — Todoist tasks appear as events, calendar events visible in Upcoming
- **Outlook Calendar**: same two-way sync
- **iCal feed**: per-project calendar feed URL you can subscribe to in any calendar app

### What MC Has
- Calendar events shown in Today's InteractiveTimeline
- `source-calendar` color defined in design system
- No two-way calendar sync or iCal feed

### Opportunity
- **iCal feed** of MC tasks (per project or "My Day") would let users see tasks in their calendar
- Two-way sync where calendar blocks inform scheduling suggestions
- Calendar connector as a source system

---

## Priority Recommendations (Ranked by Impact × Feasibility)

### 🔴 High Priority — Near Term
1. **Task row inline actions** (due date, comment icon, priority quick-set on hover)
2. **Upcoming/Planning view** with drag-to-reschedule across days
3. **Inline title editing** (double-click to edit in place)

### 🟠 Medium Priority — Design Phase
4. **Browser extension task mode** (Quick Add + Today view alongside capture)
5. **Voice/Brain dump capture** (text-first "paste a paragraph → AI extracts tasks")
6. **Comment/notes system** on tasks (beyond single description)
7. **Streak vacation mode + days off** in routines

### 🟡 Lower Priority — Longer Term
8. **Due date vs. deadline** separation
9. **Smart NLP date parsing** in Quick Add
10. **Outlook email integration** (email → triage/task)
11. **Two-way calendar sync / iCal feed**
12. **AI filter assist** ("show me..." → auto-set filters)
13. **Mobile widgets** (requires native app)

---

## Key Philosophical Takeaways

1. **Todoist optimizes for capture speed; MC optimizes for overview density.** Both are valid — but MC can borrow Todoist's capture friction-reduction without losing density.

2. **Inline actions > context menus** for frequent operations. The task row icons (date, comment, edit) pattern is a UX win MC should adopt — it keeps the user in flow without right-clicking or opening panels.

3. **Planning is a distinct activity from reviewing.** MC's Today view is great for "what should I do now?" but doesn't serve "let me plan my week." The Upcoming view with drag-to-reschedule fills this gap.

4. **Gamification works when it's opt-in.** Todoist's Karma is successful because it can be completely disabled. MC's approach with the DopamineMenu and CompletionBurst is on the right track — just ensure vacation mode and opt-out are first-class.

5. **Voice capture matters more than you'd think** — but can be approximated with text-based brain dump + AI parsing. The insight is the UX pattern (unstructured → structured), not necessarily the audio.
