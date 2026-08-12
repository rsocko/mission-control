import { describe, it, expect } from 'vitest';
import { parseDocument, previewIntake, executeIntake } from '@/lib/intake/document-intake';
import { getProjectName } from '@/lib/intake/document-intake';

describe('parseDocument — project planning format', () => {
  const projectPlanDoc = `## Project 1: Insights & Analytics Platform 🟠 P1

**Why:** The stats engine is built but has no user-facing page. This is the highest-value unshipped designed feature. Enables reflection, pattern detection, and momentum tracking — core to the ADHD-friendly product thesis.

**Issues:** #911, #568, #569, #570, #1046

### Phase 1 — Core Insights Page (MVP)
- [ ] Route \`/insights\` with period selector (7/30/90 days)
- [ ] 5 summary KPIs with period deltas (Completed, Created, Net Change, Avg Task Age, Streak)
- [ ] Completion trend bar chart (daily completed vs created)
- [ ] Source breakdown horizontal bars
- [ ] Daily completion counter badge in header (#1046)

### Phase 2 — Depth & Visualization
- [ ] Task age distribution histogram
- [ ] Routine completion heatmap (week-day grid)
- [ ] Project velocity per-project done/open delta
- [ ] Graphs: counts by Priority, Status (#911)
- [ ] Visual effort vs priority matrix (#910)

### Phase 3 — AI Intelligence Layer
- [ ] AI observations feed (pattern detection, stale work notifications, balance shifts)
- [ ] Wire AI observations endpoint to real generation (#568)
- [ ] AI-generated weekly narrative summary (#569)
- [ ] Behavior-based nudge feed sidebar panel (#570)

**Estimated Effort:** 3-4 weeks total
**Dependencies:** Stats engine (exists), Recharts (new dependency)`;

  it('should parse findings from checklist items', () => {
    const result = parseDocument(projectPlanDoc);
    expect(result.findings.length).toBe(14);
  });

  it('should parse all three phases', () => {
    const result = parseDocument(projectPlanDoc);
    expect(result.phases.length).toBe(3);
    expect(result.phases[0].name).toContain('Core Insights Page');
    expect(result.phases[1].name).toContain('Depth & Visualization');
    expect(result.phases[2].name).toContain('AI Intelligence Layer');
  });

  it('should assign finding IDs sequentially', () => {
    const result = parseDocument(projectPlanDoc);
    expect(result.findings[0].id).toBe('F-1');
    expect(result.findings[13].id).toBe('F-14');
  });

  it('should extract the project title without emoji/priority markers', () => {
    const result = parseDocument(projectPlanDoc);
    expect(result.title).toBe('Insights & Analytics Platform');
  });

  it('should set area to phase name for each finding', () => {
    const result = parseDocument(projectPlanDoc);
    // First 5 findings belong to Phase 1
    for (let i = 0; i < 5; i++) {
      expect(result.findings[i].area).toContain('Core Insights Page');
    }
    // Next 5 belong to Phase 2
    for (let i = 5; i < 10; i++) {
      expect(result.findings[i].area).toContain('Depth & Visualization');
    }
  });

  it('should set priority from P1 marker', () => {
    const result = parseDocument(projectPlanDoc);
    expect(result.findings[0].priorityOrder).toBe(1);
  });

  it('should create priority groups', () => {
    const result = parseDocument(projectPlanDoc);
    expect(result.priorityGroups.length).toBe(1);
    expect(result.priorityGroups[0].order).toBe(1);
    expect(result.priorityGroups[0].findingIds.length).toBe(14);
  });

  it('should map finding IDs to phases', () => {
    const result = parseDocument(projectPlanDoc);
    expect(result.phases[0].findingIds).toEqual(['F-1', 'F-2', 'F-3', 'F-4', 'F-5']);
    expect(result.phases[1].findingIds).toEqual(['F-6', 'F-7', 'F-8', 'F-9', 'F-10']);
    expect(result.phases[2].findingIds).toEqual(['F-11', 'F-12', 'F-13', 'F-14']);
  });

  it('should preserve issue text as the finding issue field', () => {
    const result = parseDocument(projectPlanDoc);
    expect(result.findings[0].issue).toContain('Route `/insights`');
    expect(result.findings[0].issue).toContain('period selector');
  });

  it('should extract issue refs into suggestedFix', () => {
    const result = parseDocument(projectPlanDoc);
    // Finding with #1046
    const f5 = result.findings[4];
    expect(f5.issue).toContain('#1046');
    expect(f5.suggestedFix).toContain('#1046');
  });

  it('should populate linkedIssueNumbers for findings with GitHub issue refs', () => {
    const result = parseDocument(projectPlanDoc);
    // Finding with #1046
    const f5 = result.findings[4];
    expect(f5.linkedIssueNumbers).toContain(1046);

    // Finding without issue refs should have empty array
    const f1 = result.findings[0];
    expect(f1.linkedIssueNumbers).toEqual([]);
  });
});

describe('parseDocument — audit table format still works', () => {
  const auditDoc = `# Security Audit

## Priority 1: Critical Issues

| ID | Area | Issue | Impact | Suggested Fix | Effort |
| --- | --- | --- | --- | --- | --- |
| SEC-1 | Auth | No rate limiting | Brute force attacks | Add rate limiter | Low |
| SEC-2 | API | SQL injection risk | Data breach | Use parameterized queries | Medium |

## Recommended Fix Order

1. **Phase 1** (SEC-1, SEC-2)
   - Fix auth and API vulnerabilities
   - Estimated effort: 1-2 weeks`;

  it('should still parse audit-format documents', () => {
    const result = parseDocument(auditDoc);
    expect(result.findings.length).toBe(2);
    expect(result.findings[0].id).toBe('SEC-1');
    expect(result.findings[1].id).toBe('SEC-2');
    expect(result.phases.length).toBe(1);
  });
});

describe('previewIntake — project planning format', () => {
  const doc = `## Feature: User Dashboard

### Phase 1 — MVP
- [ ] Create dashboard route
- [ ] Add user stats widget

### Phase 2 — Polish
- [ ] Add animations
- [ ] Dark mode support`;

  it('should return correct preview counts', () => {
    const preview = previewIntake(doc);
    expect(preview.proposedIssueCount).toBe(4);
    expect(preview.proposedPhases.length).toBe(2);
  });

  it('should not produce empty effort/area tags', () => {
    const preview = previewIntake(doc);
    const hasEmptyTag = preview.proposedTags.some(t => t === 'Effort ' || t === 'Area: ');
    expect(hasEmptyTag).toBe(false);
  });
});

describe('parseDocument — alphanumeric phase identifiers (4A, 4B, etc.)', () => {
  const mobileCompanionDoc = `## Project 2: Mobile Companion 🟠 P1

**Why:** Mobile unlocks the "capture anywhere" vision.

**Issues:** #629, #630

### Phase 1 — PWA Polish (Complete the Responsive Web)
- [ ] Triage card stack with swipe gestures (#629)
- [ ] Compact header — hide desktop-only elements (#630)

### Phase 2 — PWA Distribution & Push
- [ ] PWA install prompts (#1092)
- [ ] Push notification subscriptions (#635)

### Phase 3 — iOS Native Wrapper & Distribution
- [ ] Xcode project scaffolding + WKWebView host (#932)
- [ ] JS ↔ Native bridge (WebBridge.swift) (#933)

### Phase 4A — Native Quick Wins
- [ ] Home screen & lock screen widgets (WidgetKit) (#938)
- [ ] Live Activities & Dynamic Island (#939)

### Phase 4B — Core Native Features
- [ ] Siri & App Intents (#942)
- [ ] Offline-first local storage & sync engine (#944)

### Phase 4C — Extended Surfaces
- [ ] watchOS app & complications (#946)
- [ ] Handoff & Continuity (#948)

### Phase 4D — Deep Intelligence
- [ ] On-device ML — smart categorization & NLP (#950)
- [ ] App Clips for shared task lists (#951)

**Estimated Effort:** Phase 1-2: 3-4 weeks | Phase 3: 2-3 weeks | Phase 4: 4-6 weeks`;

  it('should parse all 7 phases including alphanumeric 4A-4D', () => {
    const result = parseDocument(mobileCompanionDoc);
    expect(result.phases.length).toBe(7);
    expect(result.phases[0].name).toContain('PWA Polish');
    expect(result.phases[1].name).toContain('PWA Distribution');
    expect(result.phases[2].name).toContain('iOS Native Wrapper');
    expect(result.phases[3].name).toContain('Native Quick Wins');
    expect(result.phases[4].name).toContain('Core Native Features');
    expect(result.phases[5].name).toContain('Extended Surfaces');
    expect(result.phases[6].name).toContain('Deep Intelligence');
  });

  it('should create findings for all checklist items across alphanumeric phases', () => {
    const result = parseDocument(mobileCompanionDoc);
    expect(result.findings.length).toBe(14);
  });

  it('should assign findings to correct alphanumeric phases', () => {
    const result = parseDocument(mobileCompanionDoc);
    // Phase 4A findings
    expect(result.phases[3].findingIds).toEqual(['F-7', 'F-8']);
    // Phase 4D findings
    expect(result.phases[6].findingIds).toEqual(['F-13', 'F-14']);
  });
});

describe('parseDocument — generic list format (no phases)', () => {
  const bulletListDoc = `# Sprint Tasks

- Fix login redirect bug
- Add error boundary to dashboard
- Update API rate limiting (#234)
- Write unit tests for auth module`;

  it('should parse plain bullet lists as findings', () => {
    const result = parseDocument(bulletListDoc);
    expect(result.findings.length).toBe(4);
    expect(result.findings[0].issue).toBe('Fix login redirect bug');
  });

  it('should extract issue refs from bullet items', () => {
    const result = parseDocument(bulletListDoc);
    expect(result.findings[2].suggestedFix).toContain('#234');
  });

  it('should populate linkedIssueNumbers for generic list items', () => {
    const result = parseDocument(bulletListDoc);
    expect(result.findings[2].linkedIssueNumbers).toEqual([234]);
    expect(result.findings[0].linkedIssueNumbers).toEqual([]);
  });

  it('should use heading as title', () => {
    const result = parseDocument(bulletListDoc);
    expect(result.title).toBe('Sprint Tasks');
  });

  const numberedListDoc = `# Backlog

1. Implement caching layer
2. Migrate to new auth provider
3. Add rate limiting (#45)`;

  it('should parse numbered lists as findings', () => {
    const result = parseDocument(numberedListDoc);
    expect(result.findings.length).toBe(3);
    expect(result.findings[0].issue).toBe('Implement caching layer');
  });

  const sectionsDoc = `# Refactoring Plan

## Frontend
- Migrate to React 19
- Replace custom hooks with built-in

## Backend
- Split monolith into services
- Add health check endpoints`;

  it('should group items under section headers as areas', () => {
    const result = parseDocument(sectionsDoc);
    expect(result.findings.length).toBe(4);
    expect(result.findings[0].area).toBe('Frontend');
    expect(result.findings[1].area).toBe('Frontend');
    expect(result.findings[2].area).toBe('Backend');
    expect(result.findings[3].area).toBe('Backend');
  });

  it('should create phases from section groupings', () => {
    const result = parseDocument(sectionsDoc);
    expect(result.phases.length).toBe(2);
    expect(result.phases[0].name).toBe('Frontend');
    expect(result.phases[1].name).toBe('Backend');
  });
});

describe('executeIntake — plan tweaks', () => {
  const doc = `## Feature: User Dashboard

### Phase 1 — MVP
- [ ] Create dashboard route
- [ ] Add user stats widget`;

  it('should skip selected findings during dry-run execution', async () => {
    const result = await executeIntake(doc, {
      mcUrl: 'http://127.0.0.1:3000',
      repo: 'acme/repo',
      dryRun: true,
      skipFindingIds: ['F-2'],
    });

    expect(result.document.findings.map(f => f.id)).toEqual(['F-1']);
    expect(result.issues.map(issue => issue.findingId)).toEqual(['F-1']);
    expect(result.phases[0].findingIds).toEqual(['F-1']);
  });

  it('should allow overriding proposed tags during execution', async () => {
    const result = await executeIntake(doc, {
      mcUrl: 'http://127.0.0.1:3000',
      repo: 'acme/repo',
      dryRun: true,
      tags: ['Custom', 'custom', '  ', 'Area: Frontend'],
    });

    expect(result.tags).toEqual(['Custom', 'Area: Frontend']);
  });

  it('should fail with a clear error when all findings are skipped', async () => {
    const result = await executeIntake(doc, {
      mcUrl: 'http://127.0.0.1:3000',
      repo: 'acme/repo',
      dryRun: true,
      skipFindingIds: ['F-1', 'F-2'],
    });

    expect(result.errors).toEqual(['No findings selected for intake']);
    expect(result.issues).toEqual([]);
  });

  it('should set appendedToExisting=true when existingProjectId is provided (dry-run)', async () => {
    const result = await executeIntake(doc, {
      mcUrl: 'http://127.0.0.1:3000',
      repo: 'acme/repo',
      dryRun: true,
      existingProjectId: 'proj-123',
    });

    expect(result.appendedToExisting).toBe(true);
    expect(result.projectId).toBe('proj-123');
    expect(result.phases.length).toBe(1);
    expect(result.issues.length).toBe(2);
  });

  it('should set appendedToExisting=false when no existingProjectId (dry-run)', async () => {
    const result = await executeIntake(doc, {
      mcUrl: 'http://127.0.0.1:3000',
      repo: 'acme/repo',
      dryRun: true,
    });

    expect(result.appendedToExisting).toBe(false);
    expect(result.projectId).toMatch(/^preview-/);
  });
});

describe('getProjectName — smart title derivation', () => {
  it('should use extracted title directly for non-audit documents', () => {
    const doc = parseDocument(`## Project 2: Mobile Companion 🟠 P1

**Why:** The mobile strategy is important.

### Phase 1 — PWA Polish
- [ ] Triage card stack with swipe gestures (#629)
- [ ] Compact header — hide desktop-only elements (#630)`);
    expect(getProjectName(doc)).toBe('Mobile Companion');
  });

  it('should use title from bare Project N: Name lines without markdown headers', () => {
    const doc = parseDocument(`Project 2: Mobile Companion 🟠 P1

### Phase 1 — PWA Polish
- [ ] Triage card stack (#629)`);
    expect(getProjectName(doc)).toBe('Mobile Companion');
  });

  it('should append Remediation for audit-titled documents', () => {
    const doc = parseDocument(`# Security Audit

## Priority 1: Critical
| ID | Issue | Impact |
|----|-------|--------|
| F-001 | SQL injection in login | High |`);
    expect(getProjectName(doc)).toBe('Security Audit Remediation');
  });

  it('should not append Remediation if title already contains it', () => {
    const doc = parseDocument(`# Audit Remediation Plan

## Priority 1: Critical
| ID | Issue | Impact |
|----|-------|--------|
| F-001 | XSS in profile | High |`);
    expect(getProjectName(doc)).toBe('Audit Remediation Plan');
  });

  it('should respect custom name over any derived title', () => {
    const doc = parseDocument(`## Project 1: Something Else

### Phase 1
- [ ] Task one`);
    expect(getProjectName(doc, 'My Custom Name')).toBe('My Custom Name');
  });

  it('should fall back to Untitled Project when no title is found', () => {
    const doc = parseDocument(`- [ ] Fix the thing
- [ ] Do the other thing`);
    // Generic list with no heading — title will be null
    expect(getProjectName(doc)).toBe('Untitled Project');
  });

  it('should use title directly for feature-style documents', () => {
    const doc = parseDocument(`## Feature: User Dashboard

### Phase 1 — MVP
- [ ] Create dashboard route`);
    expect(getProjectName(doc)).toBe('Feature: User Dashboard');
  });
});
