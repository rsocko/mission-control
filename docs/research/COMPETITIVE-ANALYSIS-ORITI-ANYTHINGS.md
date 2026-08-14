---
title: "Competitive Analysis: Oriti / Anythings"
status: active
created: 2026-07-08
last_reviewed: 2026-07-08
category: research
subjects:
  - "[oriti.io](https://oriti.io) (legacy)"
  - "[anythings.app](https://www.anythings.app) (current)"
context: "Same developer, rebrand with intentional feature reduction"
related:
  - "[Triage Queue](../design/TRIAGE-QUEUE-DESIGN.md)"
  - "[Insights Page](../design/INSIGHTS-PAGE-DESIGN.md)"
mockups:
  - "[mockup-smart-score-list.html](../mockups/mockup-smart-score-list.html)"
  - "[mockup-priority-entities.html](../mockups/mockup-priority-entities.html)"
  - "[mockup-insights-feed.html](../mockups/mockup-insights-feed.html)"
  - "[mockup-capture-multimodal.html](../mockups/mockup-capture-multimodal.html)"
  - "[mockup-priority-setup-wizard.html](../mockups/mockup-priority-setup-wizard.html)"
  - "[mockup-snooze-score-animation.html](../mockups/mockup-snooze-score-animation.html)"
---

# Competitive Analysis: Oriti / Anythings vs Mission Control

### Associated Mockups

| Concept | Mockup File |
|---------|-------------|
| AI Priority Scoring + Smart Sort | [mockup-smart-score-list.html](../mockups/mockup-smart-score-list.html) |
| Priority Entities (Tiered, Typed) | [mockup-priority-entities.html](../mockups/mockup-priority-entities.html) |
| Behavioral Insights Feed | [mockup-insights-feed.html](../mockups/mockup-insights-feed.html) |
| Multi-Modal Capture | [mockup-capture-multimodal.html](../mockups/mockup-capture-multimodal.html) |
| Priority Setup Wizard (First Launch) | [mockup-priority-setup-wizard.html](../mockups/mockup-priority-setup-wizard.html) |
| Snooze + Score Animation | [mockup-snooze-score-animation.html](../mockups/mockup-snooze-score-animation.html) |

---

## Executive Summary

Oriti started as a feature-rich AI task manager (Pomodoro, Kanban, analytics, focus mode, calendar views) and was deliberately stripped down to become **Anythings** — a product laser-focused on three primitives: **Capture → Convert → Order**. The developer explicitly removed Kanban, calendar views, analytics dashboards, focus mode, and gamification — concluding that users were "spending energy managing the app instead of finishing their day."

This evolution is directly relevant to Mission Control because:
1. We share the same core problem space (task aggregation + intelligent ordering)
2. Their "what to cut" list includes features we have on our roadmap (Kanban, Focus mode)
3. Their AI scoring + priority inference approach solves the "what's next?" problem we've identified
4. Their capture philosophy aligns with our Triage Queue but pushes further on unstructured input

---

## Open Source Status

| Product | Open Source? | Notes |
|---------|-------------|-------|
| Oriti | ❌ No | No public GitHub repo found |
| Anythings | ❌ No | Closed-source, commercial SaaS |
| Tech Stack (inferred) | Supabase + React/Vite | Based on HTML source (Supabase storage URLs, Vite build artifacts, Google Analytics) |

**Verdict**: Nothing directly referenceable or forkable. However, the **design patterns and algorithms** are the valuable takeaway, not code.

---

## Feature Comparison Matrix

| Capability | Oriti (legacy) | Anythings (current) | Mission Control (built) | MC (roadmap) |
|---|---|---|---|---|
| Multi-source task aggregation | ❌ Single app | ❌ Single app | ✅ Connectors | — |
| AI task scoring / priority ranking | ✅ Priority tiers + AI | ✅ Behavioral learning | ❌ | ✅ "AI Triage" |
| Unstructured input → clean tasks | ✅ Multi-task detection | ✅ Voice/email/image/PDF | ❌ | Partial (Triage Queue captures) |
| Smart date parsing (NLP) | ✅ | ✅ | ❌ | — |
| Priority context mapping | ✅ People/projects/domains | ✅ + learns from behavior | ❌ | — |
| Kanban board | ❌ (removed) | ❌ (removed) | ✅ (built) | — |
| Calendar/agenda view | ❌ (removed) | ❌ (removed) | — | — |
| Pomodoro/focus timer | ❌ (removed) | ❌ (removed) | — | "Focus Mode" planned |
| Analytics/streaks | ❌ (removed) | ❌ (removed) | — | — |
| Write-through to sources | ❌ | ❌ | ✅ | — |
| Keyboard-driven UX | Unknown | Likely minimal (mobile-first) | ✅ | — |
| Voice capture | ❌ | ✅ (Siri, dictation) | ❌ | — |
| Email capture address | ❌ | ✅ (forward-to-inbox) | ❌ | — |
| Screenshot/image → task | ❌ | ✅ (OCR + AI extraction) | ❌ | — |
| iOS Share Sheet | ❌ | ✅ | ❌ | ✅ (Triage Queue) |
| Browser extension | Unknown | Unknown | ❌ | ✅ (Triage Queue) |
| Professional/Student modes | ✅ | ❌ (removed) | ❌ | — |
| Hub Projects | ❌ | ❌ | ✅ | — |
| Connector architecture | ❌ | ❌ | ✅ | — |

---

## Key Design Concepts — What's Additive to Mission Control

### 1. 🧠 AI Priority Scoring (High Relevance)

**How they do it**: Each task gets a numeric score (0-100) based on:
- User-defined priority tiers (people, projects, domains ranked)
- Due date urgency decay
- Behavioral patterns (what you complete first, what you keep deferring)
- Context mapping (auto-linking task to priority entity)

**What's additive for MC**: Our "AI Triage" roadmap item is vague. Anythings shows a concrete model:
- **Priority entities** = our connector sources + hub projects + tags
- **Score = f(entity_rank, urgency, behavioral_weight, staleness)**
- Score is *visible* on each task (not hidden) — the number builds trust

**Recommendation**: Implement a visible composite score on unified task rows. Formula:

```
score = (entity_priority × 0.4) + (urgency_decay × 0.3) + (behavioral_weight × 0.2) + (freshness × 0.1)
```

Where:
- `entity_priority`: rank of associated project/source/person (user-configurable)
- `urgency_decay`: exponential as due date approaches (0 if no date)
- `behavioral_weight`: how quickly user acts on similar tasks (learned)
- `freshness`: recently created/touched items get slight boost

---

### 2. 📥 "Anything In" Capture Philosophy (High Relevance)

**How they do it**: The philosophy is that the *input format doesn't matter* — the system normalizes everything:
- Voice memo → transcribe → extract actions → split into tasks
- Email forward → parse → extract the ONE actionable item
- Screenshot → OCR → detect to-dos
- Brain dump text → multi-task detection → split + assign dates

**What's additive for MC**: Our Triage Queue already captures from Reddit, GitHub Stars, iOS Share Sheet. But we treat captured items as **opaque links to be routed**. Anythings goes further: it **converts unstructured content INTO tasks automatically**.

**Recommendation**: Add an AI conversion layer to the Triage Queue:

```
Capture → [AI Extraction] → Suggested tasks (with pre-filled title, due date, project, priority)
                           → User confirms/edits → Tasks created in MC + synced to sources
```

This turns the Triage Queue from a "routing inbox" into a "task factory."

---

### 3. 🔄 Behavioral Priority Learning (Medium-High Relevance)

**How they do it**:
- Watches which tasks you complete first (implicit priority signal)
- Notices which priorities you keep returning to
- Suggests adding NEW priority entities when patterns emerge
- Suggests REMOVING stale priorities you haven't touched
- All changes are suggested, never applied automatically — user approves

**What's additive for MC**: We have no behavioral tracking. Our system is purely structural (source, list, due date, manual flags).

**Recommendation**: Add a lightweight behavioral engine:
- Track `completed_at` timestamps and order-of-completion
- Track "dwell time" (how long a task stays visible before action)
- Weekly "Priority Suggestions" surface in a digest:
  - "You've completed 12 tasks from Project X this week — promote it?"
  - "You haven't touched anything from 'Home Improvement' in 30 days — archive?"
  - "Tasks tagged 'urgent' from GitHub are always completed first — auto-boost?"

---

### 4. 📊 Visible Numeric Score (Medium Relevance)

**How they do it**: Each task shows a bold number (e.g., "92", "71", "36"). The list is always sorted by score. No manual drag-and-drop reordering.

**What's additive for MC**: Our current unified view sorts by due date or source. Adding a computed score gives users a single answer to "what should I do next?" without them having to mentally weight urgency × importance × source.

**Recommendation**: 
- Add an optional "Smart Sort" mode (default off, respects our power-user ethos)
- When active: tasks show score badge, list auto-sorts
- Score calculation is transparent (hover to see breakdown)
- User can override (pin items, manual boost) — overrides feed back into behavioral model

**UI Mockup**: See [mockup-smart-score-list.html](../mockups/mockup-smart-score-list.html) for the full interactive visualization.

Score badge color system:
- Score ≥ 80: accent blue background with white text
- Score 50-79: amber tint background with amber text  
- Score < 50: surface-3 background with gray text

---

### 5. ✂️ Multi-Task Detection & Splitting (Medium Relevance)

**How they do it**: When a user enters "Email Sarah about Q3 and schedule dentist for next week", the system automatically splits into:
1. "Email Sarah about Q3" (no date)
2. "Schedule dentist" (due: next week)

**What's additive for MC**: Our Quick Add is single-task. The Triage Queue processes one item at a time.

**Recommendation**: Add multi-task detection to:
- Quick Add (Ctrl+K) — detect "and" / semicolons / line breaks as split points
- Triage Queue AI extraction — already planned, just ensure the model is prompted for multi-action detection
- Sync connector — when a Microsoft Todo task body contains a checklist, surface sub-items as individual tasks

---

### 6. 🗣️ NLP Date Parsing (Medium Relevance)

**How they do it**: "next Friday", "end of month", "tomorrow 3pm" → actual dates. No date picker ceremony.

**What's additive for MC**: We rely on source system dates. Quick Add has no date parsing.

**Recommendation**: Add chrono-node (or similar NLP date parser) to:
- Quick Add input processing
- Triage Queue AI extraction
- Inline task editing (type "due friday" → sets date)

---

## Concepts to Absorb with Variations

### A. "One List, Always Right" vs Our Multi-View Approach

**Their take**: Kill all views. One list. Score sorts it. Done.

**Our variation**: We serve a power user with 50+ tasks across multiple domains. A single flat list would be overwhelming. Instead:

> **Adopt the score. Keep the views. Let the score INFORM every view.**

- Unified list: sorted by score (default) or user choice
- Today view: top-N by score + overdue + calendar items
- Kanban: cards show score badges, columns auto-populate by score thresholds
- Portfolio: project health uses aggregate scores of child tasks

### B. "Capture Anything" vs Our Connector Model

**Their take**: Be the single inbox for the world. Everything flows in.

**Our variation**: We don't replace sources — we aggregate them. But we should add:

> **Universal capture for things that DON'T already live in a source system.**

- Voice memo → task (via mobile app or companion widget)
- Email forwarding address (similar to Anythings)
- iOS/Android Share Sheet (already planned for Triage Queue)
- Clipboard capture (Ctrl+Shift+K → paste anything → AI extracts task)

### C. "Behavioral Learning" vs Our Manual Configuration

**Their take**: The system learns silently and suggests changes.

**Our variation**: Power users distrust magic. Make it explicit:

> **"Priority Insights" panel — weekly behavioral report with actionable suggestions the user opts into.**

- Show the data: "This week you completed GitHub tasks 2.3× faster than Todo tasks"
- Show the suggestion: "Boost GitHub source priority? [Apply] [Dismiss]"
- Show the history: "You've accepted 8/10 suggestions this month"
- Never auto-apply. Always explain the reasoning.

### D. "Remove Kanban, Focus, Analytics" vs Our Roadmap

**Their lesson**: Features that sound good on paper create maintenance overhead for users.

**Our variation**: We're building for a DIFFERENT user. Their target is "everyone" (including students). Ours is a power user who *wants* density and control.

> **Keep Kanban — but make it score-informed (not manual drag ceremony).**  
> **Keep Focus Mode — but make it one-key toggle, not a "mode" with settings.**  
> **Skip analytics/streaks/gamification entirely — confirmed unnecessary by their data.**

---

## Approaches They Do Better / More Efficiently

| Area | Their Approach | Why It's Better | MC Adaptation |
|------|---------------|-----------------|---------------|
| **Input friction** | Type/speak/forward anything, AI figures it out | Zero formatting ceremony = higher capture rate | Add AI extraction to Quick Add + Triage |
| **Priority trust** | Show the number, explain on hover | User can verify and override = trust loop | Add transparent score + breakdown tooltip |
| **Pruning suggestions** | "You haven't touched X in 30 days — remove?" | Prevents priority rot | Add staleness detection to Priority Insights |
| **Date handling** | NLP parsing in every text field | No date picker = faster input | Add chrono-node to text inputs |
| **Cognitive load** | One sorted list, no views to manage | Removes "which view should I use?" decision | Offer "Zen mode" — single list, score-sorted, no sidebar |
| **Priority onboarding** | "Tell me who and what matters" setup flow | System is useful from minute one | Add priority setup wizard on first launch |

---

## Roadmap Recommendations

### Immediate (absorb into current work)

1. **AI Score Engine** — Implement priority scoring formula; show score on task rows
2. **NLP Date Parsing** — Add chrono-node to Quick Add and inline edit
3. **Multi-task splitting** — Detect compound tasks in Quick Add input
4. **Priority Entities** — Let users rank their sources/projects/people (extends Hub Projects)

### Near-term (next sprint cycle)

5. **Triage Queue AI Conversion** — Don't just route items; extract tasks from content
6. **Behavioral Tracking Foundation** — Log completion order, dwell time, action patterns
7. **"Zen Mode" View** — Single flat list, score-sorted, hide all chrome (one-key toggle)
8. **Priority Setup Wizard** — First-launch flow: "Rank your projects, people, and domains"

### Medium-term (next quarter)

9. **Priority Insights Panel** — Weekly behavioral analysis with opt-in suggestions
10. **Universal Capture Expansion** — Email forwarding address, clipboard capture hotkey
11. **Voice Input** — "Add task" via system speech-to-text → AI extraction
12. **Score-Informed Kanban** — Auto-sort cards within columns by score; suggest column moves

### Revisit / Reconsider

13. **Focus Mode** — Keep, but simplify to one-key "hide everything except my task list" (no timer, no stats, no overlay settings)
14. **Analytics** — Skip dashboards/streaks. Use behavioral data only for Priority Insights suggestions, never for gamification.

---

### UI Concept: Score Breakdown Tooltip

See [mockup-smart-score-list.html](../mockups/mockup-smart-score-list.html) — hover over any score badge to see the breakdown:

| Factor | Weight | Description |
|--------|--------|-------------|
| Project rank | 40% | Rank of associated priority entity within its tier |
| Urgency | 30% | Exponential decay as due date approaches |
| Behavior | 20% | How quickly user acts on similar tasks |
| Freshness | 10% | Recently created/touched items get slight boost |

### Priority Setup Wizard (First Launch)

See [mockup-priority-entities.html](../mockups/mockup-priority-entities.html) for the full tiered management interface. On first launch, a guided wizard walks the user through:

1. Ranking their connected sources (GitHub > Todo > Calendar > Email)
2. Ranking their top projects
3. Optionally adding key people
4. Each entity gets a context description field for AI to use

### Zen Mode (Score-Sorted Single List)

See [mockup-smart-score-list.html](../mockups/mockup-smart-score-list.html) — toggle "Smart Sort" in the toolbar to see the score-sorted view. Zen Mode hides the sidebar and alerts panel for a full-width, distraction-free score list.

---

---

## Deep Dive: Interaction Patterns (from UI Screenshots)

### Priority Entities — Typed, Tiered, Context-Rich

Oriti's priority system is **structurally richer** than a flat tag list:

**Anythings (simplified)**:
- Ranked numbered list (1. Sarah Johnson, 2. Project Nova, 3. Q4 Launch, 4. Health)
- Each has a color dot for visual identification
- Each has a **context field** — free-text description of who/what it is and why it matters ("My boss — Head of Product at Acme. Owns the roadmap I report into.")
- Context is used by AI to rank and connect tasks to priorities

**Oriti (structured)**:
- Four severity tiers: **Critical** → **High** → **Medium** → **Standard**
- Each priority entity has a **type**: Person 👤, Project 📋, Domain 🌐, Team 👥
- Within each tier, entities are ranked (#1, #2, #3...)
- Tiers have descriptions: "Mission-critical priorities", "High-impact priorities", "Important priorities", "Normal priorities"

**How this maps to Mission Control**:

| Their Concept | Our Equivalent | Gap |
|---|---|---|
| Priority tiers (Critical/High/Med/Standard) | Hub Projects + Tags | We have no explicit tier/weight system |
| Entity types (Person/Project/Domain/Team) | Connectors + Projects | We don't treat People/Domains as first-class entities |
| Context field per priority | Project description | We lack per-entity AI context |
| Color per priority | Source colors (fixed) | We don't let users pick entity colors |
| Rank within tier | sort_order on projects | Exists but not exposed prominently |

**Recommendation**: Extend Hub Projects into a **Priority Entity** system:
- Add `priority_tier` (critical/high/medium/standard) to projects AND introduce a new `priority_entities` table for People, Domains, Teams
- Add `context_description` field (used by AI scoring)
- Add user-chosen `color` per entity
- Rank within tier determines weight in score formula
- This overlaps perfectly with our Portfolio concept — tiers become the portfolio's "health" input

---

### AI Suggestion Cards — Behavioral Nudges

The screenshots reveal a **card-based suggestion system** with distinct types:

| Card Type | Trigger | Actions |
|---|---|---|
| **NEW PRIORITY SUGGESTION** | Entity mentioned in 6+ tasks recently | [Dismiss] [Add] |
| **REORDER SUGGESTION** | User completes X tasks before Y consistently | [Dismiss] [Apply] |
| **SITTING A WHILE** | Task undated for 3+ weeks | [Keep] [Drop it] [Date it] [Do it today] |
| **REMOVE PRIORITY SUGGESTION** | Nothing touched in 30+ days | [Dismiss] [Remove] |
| **ADD PERSON** | Name keeps appearing in tasks | [Dismiss] [Add] |

**Design observations**:
- Cards are dark surface with subtle border, floating above content
- Carousel dots indicate multiple pending suggestions
- Copy is conversational and evidence-based ("You finish Fundraising tasks first, almost every time")
- Actions are clear binary/ternary choices — no configuration
- "SITTING A WHILE" is genius — forces a decision on stale items without deleting them

**Recommendation for MC**: Implement an **Insights Feed** (could live in sidebar or as a dismissable panel):
- Same card types, adapted to our multi-source context:
  - "You've completed 8 GitHub tasks this week but 0 from Todo — rebalance?"
  - "Task 'Fix garage door' has no date and has been idle 3 weeks — [Keep] [Drop] [Date it] [Do today]"
  - "You always handle tasks from @sarah before @jeff — promote Sarah's priority?"
  - "Hub Project 'Kitchen Reno' has had no activity in 45 days — archive it?"

---

### "Later" Button + Score Animation

The **snooze/deprioritize** interaction they describe:
- "Later" button temporarily lowers the task's score
- Score number animates down (Number Flow / animated counter)
- Task visually shifts position in the list (slides down)
- This is **reversible** and time-bounded (score recovers over time or on next interaction)

**Recommendation for MC**: 
- Add a "Snooze" quick action (keyboard shortcut `S`) that:
  1. Applies a temporary score penalty (-20 for 24h, -10 for 48h, then recovers)
  2. Animates the score badge with Number Flow (counter ticks down)
  3. Task slides to new position with spring animation
  4. Snooze indicator shows on the task row (small clock icon + "snoozed until tomorrow")

---

### Drag to Reorder — Manual Override

They support drag-to-reorder as a **manual signal that feeds back into AI**:
- If you drag a task above another, the system interprets this as "I think this is more important"
- Future scoring incorporates your manual ordering preferences
- This is different from our Kanban drag (which changes status) — this changes *priority within a list*

**Recommendation for MC**:
- Add drag-to-reorder in unified list view (within Smart Sort mode)
- Manual reorder creates a "priority override" that decays over time
- Tooltip: "Manual position — this will influence future scoring"

---

### Entity Extraction + Inline Visual Tagging

From their UI, tasks show **extracted entities inline with color coding**:
- Person names highlighted in one color
- Project names in another
- Dates parsed and shown as chips
- This is real-time NER (Named Entity Recognition) on task text

**Recommendation for MC**:
- When a task is created/synced, run lightweight NER to detect:
  - Known priority entities (people, projects, domains from user's list)
  - Dates (chrono-node)  
  - Potential new entities (names/projects not yet in system → trigger suggestion card)
- Display as inline color-coded chips in task row
- Chips are clickable → filter by that entity

---

## Platform Extension Analysis: Multi-Modal Capture

### Current State: MC is a Next.js Web App

**Question**: Can we support all of Anythings' capture methods? What would it take?

| Capture Method | PWA Support | Native App Needed? | MC Strategy |
|---|---|---|---|
| **Type in app** | ✅ Full | No | Already supported (Quick Add) |
| **Dictate/Voice** | ✅ MediaRecorder API + Web Speech API | No | Add voice button to Quick Add, transcribe → AI extract |
| **Attach file/image** | ✅ File input + drag-drop | No | Add to Quick Add / Triage Queue |
| **Forward email** | ✅ Server-side (no PWA needed) | No | Create `capture@mc.yourdomain.com` inbox, parse with AI |
| **Home screen widget** | ❌ iOS doesn't support PWA widgets | Yes (iOS native) | Skip for now, or build companion Shortcut |
| **Share from any app (iOS)** | ❌ iOS Share Target not supported for PWAs | Yes (iOS native) | **Workaround**: iOS Shortcut → POST to MC API (already planned for Triage Queue) |
| **Share from any app (Android)** | ✅ Share Target API works | No | Add `share_target` to PWA manifest |
| **Ask Siri** | ❌ Requires native app | Yes (iOS native) | iOS Shortcut can call MC API via HTTP |
| **Browser extension** | ✅ (separate extension) | Chrome/Firefox ext | Build lightweight "Save to MC" extension |
| **Screenshot capture** | ✅ Clipboard API / paste | No | Accept pasted images, OCR with AI |
| **Clipboard paste** | ✅ Clipboard API | No | Ctrl+V in Quick Add → detect content type → AI extract |

### Recommended Platform Strategy

```
┌──────────────────────────────────────────────────────────────┐
│                    CAPTURE SURFACE TIERS                       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Tier 1 — Web App (PWA) [BUILD FIRST]                       │
│  ├─ Quick Add with voice, paste, attach                     │
│  ├─ Drag-and-drop files/images                              │
│  ├─ Android Share Target (PWA manifest)                     │
│  └─ Web Push notifications                                  │
│                                                              │
│  Tier 2 — Server-Side Capture [BUILD SECOND]                │
│  ├─ Email forwarding address (capture@...)                  │
│  ├─ REST API endpoint (POST /api/triage/capture)            │
│  ├─ iOS Shortcut (calls REST API) ← already planned!       │
│  └─ Webhook receivers (Slack, Teams, etc.)                  │
│                                                              │
│  Tier 3 — Browser Extension [BUILD THIRD]                   │
│  ├─ "Save to MC" context menu on any page                  │
│  ├─ Screenshot selection → OCR → task                       │
│  ├─ Highlight text → right-click → create task             │
│  └─ Auto-detect action items on pages (optional)           │
│                                                              │
│  Tier 4 — Native Companion (FUTURE / OPTIONAL)              │
│  ├─ iOS widget (today view / quick add)                     │
│  ├─ iOS Share Sheet target                                  │
│  ├─ Siri Shortcuts integration                             │
│  └─ watchOS complication                                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Key insight**: A PWA covers ~70% of the capture methods. The remaining 30% (iOS widget, Share Sheet, Siri) require native code BUT can be mostly covered by **iOS Shortcuts + our existing REST API**. A browser extension fills the desktop gap elegantly.

**Should we make MC a PWA?** → **Yes, absolutely.** It's low-effort (add a manifest + service worker to Next.js) and unlocks:
- Installable on desktop and Android
- Android Share Target
- Web Push notifications
- Offline task viewing (cached)
- Voice recording via MediaRecorder API

---

## Input Formats Audit

From their "Works with every format" section:

| Format | Their Support | MC Current | MC Should Add? | Implementation |
|---|---|---|---|---|
| Screenshot | ✅ | ❌ | ✅ | Paste/attach → OCR (GPT-4V or Tesseract) → extract tasks |
| PDF | ✅ | ❌ | ✅ | Upload → text extraction → AI task detection |
| Slack Message | ✅ | ❌ | ✅ (Tier 2) | Webhook or forward → parse |
| Photo | ✅ | ❌ | ✅ | Same as screenshot (camera or attach) |
| Plain Text | ✅ | ✅ (Quick Add) | ✅ Enhanced | Add multi-task split + NLP dates |
| Calendar event | ✅ | ✅ (Outlook connector) | — | Already synced |
| Teams Message | ✅ | ❌ | ✅ (Tier 2) | Webhook/forward |
| Receipt | ✅ | ❌ | Maybe | Lower priority for our use case |
| Quick Note | ✅ | ❌ | ✅ | Voice memo or typed note → AI extraction |
| Google Doc | ✅ | ❌ | Maybe | Future connector |
| Business Card | ✅ | ❌ | ❌ | Not relevant for our user |
| Clipboard Paste | ✅ | ❌ | ✅ | Detect content type on paste, process accordingly |

---

## Updated Priority Entity Schema Proposal

Merging Oriti's structured approach with our existing Hub Projects:

```sql
-- Priority Entities (extends the concept beyond just "projects")
CREATE TABLE priority_entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,  -- 'person' | 'project' | 'domain' | 'team' | 'source'
  tier TEXT NOT NULL DEFAULT 'medium',  -- 'critical' | 'high' | 'medium' | 'standard'
  rank_in_tier INTEGER NOT NULL DEFAULT 1,
  color TEXT,  -- user-chosen hex color
  context_description TEXT,  -- free-text AI context ("My boss, owns roadmap...")
  hub_project_id TEXT REFERENCES hub_projects(id),  -- link to existing project if applicable
  connector_id TEXT,  -- link to source connector if applicable
  is_ai_suggested BOOLEAN DEFAULT FALSE,
  last_activity_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tracks which entities are detected in which tasks
CREATE TABLE task_entity_links (
  task_id TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES priority_entities(id),
  confidence REAL DEFAULT 1.0,  -- AI confidence for auto-detected links
  is_manual BOOLEAN DEFAULT FALSE,
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, entity_id)
);

-- Behavioral tracking for priority learning
CREATE TABLE priority_signals (
  id TEXT PRIMARY KEY,
  entity_id TEXT REFERENCES priority_entities(id),
  signal_type TEXT NOT NULL,  -- 'completed_first' | 'deferred' | 'snoozed' | 'manual_reorder'
  strength REAL DEFAULT 1.0,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

This unifies:
- Our existing Hub Projects (type='project')
- New People entities (extracted from task text)
- Domains (email domains, work areas)
- Teams (groups of people)
- Sources (our connectors, elevated to priority entities)

---

## Key Takeaways

1. **Anythings validates our "AI Triage" direction** but shows it needs to be more than suggestions — it needs to be a **visible, trustworthy score** that replaces manual priority management.

2. **Their capture philosophy upgrades our Triage Queue** from "link router" to "task factory" — AI extraction on inbound content is the missing piece.

3. **Their pruning experiment validates our concern**: Kanban, focus timers, and analytics are risky features for general audiences. We keep them because our user IS the power user — but we should build them lean and score-informed, not as standalone "modes."

4. **Behavioral learning is the long-term moat**. The system that learns which tasks you actually do (vs. which you defer) will always produce better ordering than static priority rules. Start tracking behavior NOW even before the insights UI is built.

5. **No open source to leverage**, but the design patterns are clear enough to implement independently. The scoring formula, behavioral tracking schema, and priority entity model are all implementable without their code.

6. **PWA is the right next platform move** — it unlocks Android Share Target, voice capture, push notifications, and installability with minimal effort. iOS gaps are covered by Shortcuts + REST API.

7. **Priority Entities are the connective tissue** between our Portfolio/Projects system and intelligent scoring. Elevating People, Domains, and Teams to first-class ranked entities (not just tags) is what makes their scoring work.

8. **The suggestion card pattern is killer UX** — evidence-based, conversational, binary actions, never auto-applies. This should be our "Insights Feed" in the sidebar.

9. **"Sitting A While" nudges prevent task rot** — something our current system has no defense against. Stale undated tasks need active prompts to resolve.

10. **Browser extension is the desktop capture gap-filler** — "Save to MC" context menu + screenshot selection covers what PWA can't do on desktop.
