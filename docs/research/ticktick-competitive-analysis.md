# TickTick vs Mission Control — Feature Gap Analysis

## Context
TickTick (Appest Inc.) is positioned as the most feature-dense personal to-do app on the market. This analysis identifies TickTick features that are **uniquely implemented or absent from Mission Control** and worth considering for the roadmap.

---

## High-Value Gaps (Worth Considering)

### 1. 🍅 Pomodoro Timer as a First-Class Feature
**TickTick**: Built-in Pomodoro timer launched from any task. Tracks per-task session history, distraction log during sessions, time-of-day productivity curves, and cumulative focus time stats.

**MC Status**: Has a focus timer in My Day (`TimerPanel.tsx`) with 15/25/45/60min presets, progress ring, pause/resume, and browser notifications. Missing: per-task session history tracking and Pomodoro statistics feeding into Insights.

**Why it matters**: MC already has energy check-ins, "What's Next" AI, and Focus mode. Adding session tracking would tie them together — actual time-on-task data feeds the Insights engine and makes AI suggestions smarter. The per-task Pomodoro count also answers "where does my time actually go?" which is invisible today.

**Recommendation**: Add a `focus_sessions` table to record completed sessions. Show per-task time badges and feed data into Insights.

---

### 2. 🎵 White Noise / Ambient Sounds in Focus Mode
**TickTick**: Bundled ambient sound library (rain, café, forest, ocean) playable during focus sessions. Eliminates switching to a separate focus app.

**MC Status**: Not on roadmap.

**Why it matters**: Low implementation cost, high "stickiness" factor. Users who start a focus session in MC won't need to context-switch to Brain.fm or Spotify. Fits the "act from anywhere" design principle.

**Recommendation**: Lower priority but high delight-per-effort ratio. Could be a Phase 2 addition to Focus mode.

---

### 3. 📊 Eisenhower Matrix View
**TickTick**: Dedicated 4-quadrant view (Urgent+Important / Not Urgent+Important / Urgent+Not Important / Neither). Drag-and-drop between quadrants updates task priority/urgency.

**MC Status**: Has Quick Sort and Triage, but no spatial priority matrix. The Smart Score system is algorithmic, not visual-spatial.

**Why it matters**: The Eisenhower Matrix is a well-known mental model. MC's Smart Score is more powerful (algorithmic, multi-factor) but less *intuitive* for quick visual triage. The matrix gives users a spatial "lay of the land" that a ranked list doesn't.

**Recommendation**: Consider as an optional view mode alongside the existing Smart Score list. Could auto-populate quadrants from Smart Score factors (urgency from due date proximity, importance from priority entities/tags).

---

### 4. 🔁 "After Completion" Recurrence Mode
**TickTick**: Tasks can recur N days *after you actually complete them*, not on fixed calendar dates. Example: "Clean the grill — every 14 days after completion."

**MC Status**: Routines system has `every_n_days` cadence with `minDays`/`maxDays`, which is similar but lives in the Routines module, not on regular tasks. Regular tasks have `taskSchedules.recurrence` but the supported patterns aren't clear.

**Why it matters**: This is the correct model for maintenance tasks where the interval matters more than the calendar day. MC's routines system partially covers this, but the distinction between "routine" and "recurring task" may confuse users.

**Recommendation**: Ensure the task-level recurrence system supports "after completion" mode, not just fixed-calendar patterns. This may already be possible via routines — if so, surface it more prominently.

---

### 5. ⏱️ Countdown to Target Date
**TickTick**: Set a future date → TickTick shows a persistent countdown (months, days remaining). PCMag calls this unique among all to-do apps.

**MC Status**: Projects have `targetDate` but no countdown visualization.

**Why it matters**: Trivial to implement, surprisingly sticky. Useful for project deadlines, personal milestones, launch dates. Fits the "density over simplicity" principle — show time-remaining as a first-class metric.

**Recommendation**: Add a countdown badge/widget to project cards and the dashboard. Low effort, high visibility.

---

### 6. 📍 Location-Based Reminders
**TickTick**: Geofenced reminders that trigger when arriving at or leaving a location, with configurable radius.

**MC Status**: Not on roadmap. MC has `reminderAt` (time-based) only.

**Why it matters**: Requires native mobile app or deep PWA integration (Geolocation API + service worker). Given MC is web-first/PWA, this is architecturally harder. However, it's a powerful feature for personal task management (errands, context-based work).

**Recommendation**: Defer until/unless MC goes native mobile. The PWA Geolocation API could support basic "remind me when near X" but battery/background constraints make it impractical as a web app.

---

## Medium-Value Observations

### 7. Dual Checklist + Subtask Model
**TickTick**: Tasks can have both lightweight checklist items (checkboxes in description) AND full subtasks (with their own dates, priorities, assignees) simultaneously.

**MC Status**: Has `isChecklistItem` boolean on tasks + subtask hierarchy via `parentId`/`depth`. The schema supports this, but the UX distinction isn't clear from the code.

**Recommendation**: Verify the UX clearly separates "quick checklist" from "full subtask with metadata." TickTick's dual model is praised for flexibility.

---

### 8. Calendar as Task Scheduler (Time Blocking)
**TickTick**: Drag tasks onto calendar time slots to schedule them. Calendar shows tasks and external events on the same timeline.

**MC Status**: My Day has a "scheduled timeline" with time blocks, and `taskSchedules` supports `scheduledTime` + `estimatedDuration` + `isTimeBlocked`. Calendar events come from Outlook connector.

**Recommendation**: MC already has the data model. Ensure the Timeline view supports drag-to-schedule and shows calendar events alongside tasks (not just dots-on-days). This would match TickTick's strongest calendar feature.

---

### 9. Statistics: Triple-Domain Dashboard
**TickTick**: Statistics combines task completion, Pomodoro focus time, and habit streaks into one analytics view. Includes time-of-day productivity heatmap.

**MC Status**: Insights page designed but not yet built. Stats engine ready. Routines have their own insights tab.

**Recommendation**: When building Insights, consider unifying task + routine + focus session (if added) data into a single dashboard rather than siloed views. The time-of-day heatmap is particularly valuable for the Energy-aware "What's Next" feature.

---

### 10. Voice Input + Email-to-Task
**TickTick**: Voice capture via device microphone with NLP. Forward emails to a TickTick address → auto-created as tasks.

**MC Status**: Has multi-modal capture (triage queue from GitHub Stars, Reddit, iOS Shortcuts, browser extension). No voice input or email-to-task.

**Recommendation**: Email-to-task could be a lightweight connector addition. Voice input is less critical for a desktop-first power user tool but worth noting.

---

## What MC Does Better Than TickTick

| MC Advantage | Detail |
|---|---|
| **AI-powered triage & suggestions** | TickTick has zero AI. MC has streaming AI chat, auto-triage, "What's Next", energy-aware recommendations |
| **Multi-source aggregation** | TickTick is self-contained. MC pulls from MS Todo, GitHub, Outlook, and future connectors |
| **Smart Score algorithm** | TickTick has manual priority flags. MC has multi-factor algorithmic scoring with entity rankings |
| **Wave/Phase planning** | TickTick has flat projects. MC has project phases with dependencies and Gantt visualization |
| **Content triage inbox** | TickTick has no content capture/routing. MC has a full triage queue for links, repos, videos |
| **Micro-statuses** | TickTick: todo/done. MC: "waiting on someone," "started but stuck," "ready but unmotivated" |
| **Weekly/Monthly resets** | TickTick has no reflection workflow. MC has structured reset ceremonies with AI summaries |
| **Goals→Project promotion** | TickTick has no goal lifecycle. MC promotes ideas→goals→projects with AI "Develop" |
| **Information density** | MC's design system explicitly optimizes for density. TickTick targets a broader audience with more whitespace |

---

## Additional Feature Deep-Dive (Round 2)

### 11. 🖥️ Desktop Shortcut / Floating Quick-Add Widget
**TickTick**: On Mac, TickTick lives in the menu bar — clicking opens a pop-up panel with tasks + Pomodoro timer. On Windows, it sits in the system tray with a global keyboard shortcut for quick-add. On Android, a "Quick Ball" floating bubble lets you create tasks even from the lock screen.

**MC Status**: MC is a web app — no system tray or menu bar presence. Has `Ctrl+K` command palette within the app.

**Why it matters**: The always-available capture point (without opening the full app) is a key workflow for power users. MC's PWA nature makes system tray integration harder, but a browser extension with a quick-add popup could serve the same purpose.

**Recommendation**: Consider a lightweight browser extension for quick task capture. Lower priority than core features.

---

### 12. 🔔 "Annoying Alert" — Persistent Nag Reminder
**TickTick**: Officially named "Annoying Alert." When enabled on a task, the reminder **repeats every minute** until the user dismisses or completes the task. Designed for time-sensitive tasks you absolutely cannot miss.

**MC Status**: Has `reminderAt` (single time-based reminder). No persistent/nag mode.

**Why it matters**: Simple and effective for critical deadlines. The "Focus countdown timer" on MC's roadmap is spiritually similar (pressure-based) but doesn't nag via notifications. This could be a lightweight addition to the existing reminder system — just a `nagUntilDone` boolean flag that re-fires the notification at intervals.

**Recommendation**: Low effort to implement on top of existing reminder infrastructure. Add as an option when setting a reminder.

---

### 13. 📅 Yearly Heatmap / Activity Calendar
**TickTick**: Has a yearly calendar view showing task distribution across 12 months. Tasks appear as indicators on their respective days — heavier days show more density.

**MC Status**: Timeline view shows a monthly calendar with priority-colored dots. Insights page designed but not built. Routines already have a GitHub-style heatmap (28 weeks).

**Why it matters**: A GitHub-style completion heatmap (darker = more tasks completed that day) is a powerful motivational visualization. MC already has the heatmap concept in Routines — extending it to all task completions for the Insights page would be valuable. Shows patterns like "I'm most productive on Tuesdays" at a glance.

**Recommendation**: Build a unified completion heatmap (GitHub contribution graph style) for the Insights page. Data already exists via `completedAt` timestamps on tasks. Combine with routine completions for a full picture.

---

### 14. 🎨 List/Project Background Customization
**TickTick**: Per-list custom backgrounds — users can upload images or choose from a theme library. Backgrounds carry over to calendar view and Pomo timer for visual harmony. Custom list icons also available.

**MC Status**: Projects have `color` and `icon` fields. No background image support.

**Why it matters**: Visual differentiation helps context-switching between projects. When you open "Home Improvement" vs "3D Printing," a distinct background immediately signals which context you're in. However, MC's design principle is "density over simplicity" and "never decorative" — custom backgrounds could conflict with the information-dense dark-first aesthetic.

**Recommendation**: Consider subtle per-project theming (accent color tinting header/border) rather than full background images. MC's design language wouldn't benefit from photo backgrounds, but color-coded project headers could help distinguish contexts.

---

### 15. 📋 Task Audit Trail (Premium)
**TickTick**: Premium feature showing edit history on tasks and project lists — who changed what, when. Particularly useful for shared/collaborative lists.

**MC Status**: No task edit history. `prioritySyncLog` tracks priority changes during sync, but no general audit trail.

**Why it matters**: MC is single-user, so "who changed it" is less relevant. But "what changed and when" is useful for understanding task evolution — especially for tasks that have been sitting around for weeks. Pairs well with micro-statuses ("when did this go from 'in progress' to 'stuck'?").

**Recommendation**: Lower priority for single-user, but could feed into AI analysis ("this task has been reclassified 4 times — maybe it needs to be broken down").

---

### 16. 🔔 Subtask Reminders
**TickTick**: Likely does NOT support independent reminders on subtasks — subtasks are checklist-style items under a parent task. Parent tasks support up to 5 reminders (premium).

**MC Status**: Subtasks are full task entities (with `parentId`/`depth`) and already have `reminderAt` field.

**Why it matters**: MC actually has an advantage here — since subtasks are full task entities in the schema, they can already have independent reminders. Worth verifying the UI surfaces this capability.

---

### 17. 🔗 Notable Integrations
**TickTick's native integrations:**

| Integration | MC Equivalent |
|---|---|
| Google Calendar sync | Outlook Calendar connector (built). Google Calendar connector could be added |
| Gmail add-on (email→task) | Not present — triage queue serves some of this via iOS Shortcuts |
| Outlook add-in (email→task) | Outlook connector syncs calendar/tasks, but no "convert this email to task" flow |
| Chrome/Firefox/Edge extensions | Not present — PWA only |
| Slack notifications | Not present |
| Amazon Alexa voice | Not present (web-only) |
| Siri Shortcuts (iOS) | iOS Shortcuts webhook exists for triage capture |
| **MCP Server** (`mcp.ticktick.com`) | MC has its own MCP server (`src/mcp/`) |

**Worth considering**: A Chrome extension for quick capture would be the highest-value integration to add. Gmail/Outlook "convert email to task" is compelling but architecturally complex.

---

### 18. 📊 Statistics Deep-Dive
**TickTick's statistics dashboard includes:**
- Pomodoro timer usage (session counts, total focus time)
- Focus time by time-of-day (when you're most productive)
- Task completion rate (% completed by due date vs. late)
- Achievement score (gamified points — increases on-time, decreases on miss)

**MC comparison**: MC's designed Insights page covers completion trends, source breakdown, task age distribution, routine heatmap, and project velocity — plus AI-generated observations. MC's approach is more analytical and AI-driven. TickTick's time-of-day productivity curve is the key missing data point — but that requires focus session tracking (item #1) to be meaningful.

---

## Summary: Top Roadmap Candidates from TickTick

### High priority
1. **Focus Session Tracking** (per-task time history + Pomodoro stats) — feeds Insights + AI
2. **Eisenhower Matrix view** — visual triage complement to Smart Score
3. **Target Date Countdown** — trivial to build, high visibility
4. **"After Completion" recurrence** — verify routines cover this; surface on tasks
5. **Completion Heatmap** (GitHub-style yearly view) — for Insights page

### Medium priority
6. **"Annoying Alert" nag reminder** — low effort addition to existing reminder system
7. **Ambient sounds in Focus mode** — low cost, high delight
8. **Browser extension for quick capture** — always-available task creation

### Lower priority / monitor
9. **Per-project accent theming** — subtle color differentiation between projects
10. **Task audit trail** — useful for AI analysis of task evolution
11. **Google Calendar connector** — expand beyond Outlook
12. **Email-to-task flow** — compelling but architecturally complex
