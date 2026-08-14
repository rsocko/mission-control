---
title: "Voice Capture — Audio-to-Task Input"
status: proposed
created: 2025-07-25
last_reviewed: 2025-07-25
category: design
origin: "Issue #17 — Smart way to take audio, to-do, an auto classify categorize, and file them in the right place"
related:
  - "[Triage Queue](triage-queue.md)"
  - "[Mobile Companion](mobile-companion.md)"
  - "[Houston Voice and Flight Director UI](houston-voice-and-operations-ui.md)"
  - "[Multimodal Capture Mockup](../../mockups/mockup-capture-multimodal.html)"
---

# Voice Capture — Audio-to-Task Input

## Summary

Add a voice-capture mode to the Quick Capture flow so users can dictate tasks, notes,
and triage items hands-free. Audio is transcribed (on-device or via API), then fed
through the existing capture → triage pipeline with optional auto-classification.

---

## Problem Statement

The current Quick Capture page (`/capture`) and the browser extension only accept
typed text and pasted URLs. When users are mobile, driving, cooking, or otherwise
hands-busy, there is no way to capture a thought without switching to a separate
notes app and manually re-entering it later. This increases friction and causes
ideas to be lost.

---

## User Stories

| # | As a…       | I want to…                                         | So that…                                          |
|---|-------------|-----------------------------------------------------|---------------------------------------------------|
| 1 | Mobile user | Tap a mic button and dictate a task                 | I can capture thoughts without typing              |
| 2 | Mobile user | Have my audio auto-transcribed into a task title     | The capture is immediately usable                  |
| 3 | Power user  | Have voice captures auto-classified by the triage engine | They arrive pre-tagged like any other capture  |
| 4 | Mobile user | Review and edit the transcription before saving      | Mistakes are caught before the task is committed   |

---

## Proposed Design

### Entry Points

1. **Capture page (`/capture`)** — Add a microphone toggle button next to the title input.
2. **Mobile bottom nav** — Long-press the "+" FAB to start voice capture directly.
3. **Browser extension** — Optional: add mic button to the popup capture form.

### Capture Flow

```
┌──────────┐    ┌───────────────┐    ┌──────────────┐    ┌────────────┐
│ Tap mic  │───▶│ Record audio  │───▶│ Transcribe   │───▶│ Pre-fill   │
│ button   │    │ (MediaRecorder│    │ (Whisper API  │    │ title/body │
└──────────┘    │  API)         │    │  or on-device)│    │ fields     │
                └───────────────┘    └──────────────┘    └─────┬──────┘
                                                               │
                                                      ┌───────▼───────┐
                                                      │ User reviews  │
                                                      │ & submits     │
                                                      └───────────────┘
```

### Transcription Strategy

| Option             | Pros                              | Cons                           |
|--------------------|-----------------------------------|--------------------------------|
| **OpenAI Whisper API** | High accuracy, multilingual    | Requires API key, network      |
| **Browser Web Speech API** | Free, on-device, instant  | Accuracy varies, no Safari iOS  |
| **Self-hosted Whisper** | Private, no per-call cost     | Requires GPU/server resources  |

**Recommendation:** Start with the **Web Speech API** as default (zero cost, instant),
with an opt-in setting to use the OpenAI Whisper API for higher accuracy.
Leverage the existing AI provider settings (`/settings` → AI Provider section).

### Audio Handling

- Use `MediaRecorder` API for recording (WebM/Opus codec).
- Max recording duration: 2 minutes (configurable).
- Visual feedback: animated waveform or pulsing ring during recording.
- Tap-to-stop or auto-stop on silence (2 seconds of silence threshold).

### Post-Transcription

Once transcribed, the text is treated identically to a typed capture:
- Pre-fills the task title field (first sentence) and body (remaining text).
- If auto-triage is enabled, runs through SmartScore suggestion engine.
- User can edit before saving.

---

## Technical Considerations

- **Permissions:** Browser will prompt for microphone access; handle denial gracefully.
- **Mobile PWA:** `MediaRecorder` and `getUserMedia` are supported on modern mobile browsers.
- **Offline:** Web Speech API requires network on most browsers; provide clear offline fallback messaging.
- **Privacy:** Audio is never stored; only the transcribed text is persisted.

---

## Out of Scope (for initial version)

- Continuous/ambient listening ("always on" capture).
- Multi-language auto-detection (use browser/device locale).
- Audio attachment storage (save the original recording alongside the task).

---

## Success Metrics

- Voice capture usage rate (% of captures using mic vs typed).
- Transcription accuracy (user edit rate after transcription).
- Time-to-capture reduction vs typed input.
