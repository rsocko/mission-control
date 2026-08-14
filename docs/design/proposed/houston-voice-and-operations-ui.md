---
title: "Houston Voice and Flight Director UI"
status: proposed
created: 2026-08-08
last_reviewed: 2026-08-08
category: design
contract_version: 1
related:
  - "[JARVIS Assistant Landscape and Mission Control Strategy](../../research/jarvis-assistant-landscape-and-mission-control-strategy.md)"
  - "[Voice Capture](voice-capture.md)"
  - "[Desktop Quick Add](desktop-quick-add.md)"
  - "[Houston AI Identity](../active/houston-ai-identity.md)"
  - "[AI Engine Architecture](../../architecture/ai-engine.md)"
mockups:
  - "[Houston Flight Director interactive concept](../../mockups/mockup-houston-operations.html)"
---

# Houston Voice and Flight Director UI

## Summary

Houston Voice is the conversational interface to Mission Control. Flight Director
is the visual operations surface that explains how Houston delegates, where work
runs, what capabilities it received, what changed, and how to stop or reverse it.
Houston Companion is the thin local endpoint for audio, native notifications,
global push-to-talk, and narrowly allowlisted PC actions.

The experience has three coordinated surfaces:

1. **Houston Voice** — a semantic conversation UI with an original 3D
   constellation core representing voice state and audio activity.
2. **Flight Director** — a deterministic execution graph, timeline, and evidence
   inspector for active and completed runs.
3. **Houston Companion** — a Tauri tray surface for device state, local actions,
   visual approvals, and emergency stop.

The [interactive mockup](../../mockups/mockup-houston-operations.html) is the
reference concept. It is a dependency-free design study, not production code.

## Decision

- Build an original **Houston constellation core**, not a literal JARVIS or arc
  reactor replica.
- Adopt **Three.js + React Three Fiber 9** for the production 3D renderer.
- Reuse selected MIT/ISC algorithms and visual primitives with attribution;
  do not take fan projects as runtime dependencies.
- Preserve meaningful state in normal DOM text and controls. The 3D scene is
  decorative and never the only representation of system state.
- Keep the active-run graph deterministic. Use force-directed constellations
  only for optional historical or ecosystem exploration.
- Keep Mission Control authoritative for policy, approvals, durable runs,
  receipts, and evidence. The visualizer does not infer execution state.

## Goals

1. Make voice state immediately understandable without reading a transcript.
2. Give Houston a distinctive, cinematic identity that still belongs to Mission
   Control's dark, professional design system.
3. Show execution custody and locality for every delegated action.
4. Make approvals, errors, evidence, receipts, and reversal actions more visible
   than decorative motion.
5. Scale from browser push-to-talk to desktop, iOS, and room companions.
6. Degrade safely on reduced-motion, low-power, and WebGL-unavailable devices.

## Non-goals

- Reproduce film frames, Marvel branding, JARVIS labels, MARK identifiers,
  helmet imagery, actor voices, or a recognizable arc-reactor design.
- Turn every Mission Control page into a HUD.
- Use continuous particles, Matrix rain, fake radar, or gauges without a
  defined state or metric.
- Render authoritative task or agent state from animation timing.
- Put general shell, filesystem, connector, or desktop authority in the
  visualizer or Companion renderer.

## Surface hierarchy

### Houston Voice

The primary conversation surface contains:

- constellation core;
- explicit state label and concise heading;
- live and final transcript;
- interruption, mute, and end-session controls;
- current specialist and locality;
- dispatch and approval cards;
- latency and connection diagnostics when expanded.

The core should occupy hero space only during a focused voice session. In
ordinary Houston chat it collapses to a compact status pulse.

### Flight Director

The operations surface contains:

- active and recent run list;
- locality swimlanes;
- causal execution graph;
- critical-path span timeline;
- selected-node evidence and receipt inspector;
- graph/list view switch;
- global cancellation and locality-specific stop actions.

Required locality labels include:

- This PC and device name;
- Mission Control host;
- Microsoft 365 or other tenant;
- GitHub Cloud;
- external service;
- sandbox or disposable VM.

### Houston Companion

The tray surface contains:

- paired device and Mission Control connection state;
- microphone, playback, and wake-word state;
- global push-to-talk shortcut;
- active local actions;
- pending on-device approvals;
- offline capture outbox;
- links to Houston and Flight Director;
- prominent **Stop all local actions** control.

Companion remains a capability broker, not an autonomous local agent.

## Voice state model

| State | Required text | Core behavior | Color role |
|---|---|---|---|
| Idle | Ready | Slow rotation, sparse shimmer, no audio response | Blue |
| Listening | Listening | Audio-reactive expansion and local amplitude movement | Cyan |
| End of turn | Finishing input | Contracting ring and reduced particle velocity | Cyan to violet |
| Thinking | Routing or reasoning | Faster topology rotation and link traversal | Violet |
| Speaking | Speaking | Smoothed output RMS/FFT drives shell and fragments | Green |
| Waiting for approval | Approval required | Motion slows; approval ring and card receive priority | Amber |
| Degraded | Degraded route | Controlled irregular pulse, never rapid flashing | Red |
| Disconnected | Disconnected | Static dim fallback with reconnect action | Gray |

Color is supplementary. Text, iconography, and motion pattern must independently
communicate each state.

## Constellation core visual specification

### Visual layers

Render from inside out:

1. luminous morphing core;
2. inner Fresnel or wireframe shell;
3. depth-sorted constellation points;
4. precomputed proximity links;
5. moving link pulses for real dispatch or audio events;
6. orbital geometric fragments using instancing;
7. sparse HUD rings and ticks;
8. optional restrained bloom on capable devices.

The geometry should feel assembled from active subsystems rather than like a
single glossy ball. Fragments and links must have stable motion families so the
result reads as a coherent mechanism instead of particle noise.

### Production component

```text
HoustonVoiceCore3D
  Canvas                         dynamically imported, client-only
  THREE.Points                   constellation nodes
  THREE.LineSegments             precomputed links
  InstancedMesh                  orbital fragments
  custom shader uniforms         state, pulse, RMS, FFT bands, quality
  optional postprocessing        bloom on capable devices
  HoustonVoiceCore2D             reduced-motion/WebGL/low-power fallback
```

Recommended packages:

- `three`
- `@react-three/fiber` v9
- selected `@react-three/drei` helpers
- optional `@react-three/postprocessing`

Do not use D3, XYFlow, or a force simulation for the decorative core. Continue
using XYFlow for deterministic execution graphs.

### Data contract

```ts
type HoustonVoiceState =
  | "idle"
  | "listening"
  | "end_of_turn"
  | "thinking"
  | "speaking"
  | "waiting_approval"
  | "degraded"
  | "disconnected";

interface HoustonVoiceVisualState {
  state: HoustonVoiceState;
  inputRms?: number;
  outputRms?: number;
  fftBands?: readonly number[];
  activeSpecialist?: string;
  locality?: string;
  connected: boolean;
  reducedMotion: boolean;
  quality: "static" | "low" | "balanced" | "high";
}
```

Clamp and smooth all audio values before assigning shader uniforms. Never send
raw audio into the visual component.

## Reusable implementation decisions

| Source | Disposition | Use |
|---|---|---|
| [Three.js connected-particle example](https://threejs.org/examples/#webgl_buffergeometry_drawrange) | Adopt pattern | Points, additive links, rotation, draw ranges |
| [React Three Fiber](https://github.com/pmndrs/react-three-fiber) | Adopt dependency | React 19/Next.js renderer and lifecycle |
| [Drei](https://github.com/pmndrs/drei) | Adopt selectively | Points, instancing, adaptive DPR, performance monitor |
| [React Postprocessing](https://github.com/pmndrs/react-postprocessing) | Optional | Capability-gated bloom |
| [Three.js Orb Visualizer](https://codepen.io/filipz/pen/yyyRgry) | Port selected MIT concepts | Displacement, Fresnel shell, FFT metrics, radial rings |
| [JARVIS Neural Interface AI](https://github.com/vijaym2k6/Jarvis-Neural-Interface-AI) | Port MIT algorithms | Cluster topology, instanced nodes, link pulses |
| [r3f-forcegraph](https://github.com/vasturiano/r3f-forcegraph) | Conditional | Real historical agent/task graphs only |
| [openclaw-jarvis-ui](https://github.com/jincocodev/openclaw-jarvis-ui) | Reference | State and power-save ideas; do not copy DOM particle field |
| Literal fan replicas or repositories without a verified license | Do not copy | Visual research only |

Copy license notices into the final implementation's third-party notices when
code is ported. Record the source and commit or Pen revision in the implementation
pull request.

## Flight Director graph specification

### Node types

- human requester;
- Houston orchestrator;
- specialist agent;
- deterministic workflow;
- connector or external service;
- local device action;
- coding session;
- sandboxed computer-use worker.

Node shape must communicate type consistently. Each node shows:

- executor;
- lifecycle state;
- locality;
- elapsed time;
- current step;
- capability grants;
- errors or approval wait.

### Lifecycle

```text
Proposed -> Approval -> Queued -> Claimed -> Running
         -> Waiting / Reviewing
         -> Completed / Failed / Cancelled
```

Edges represent typed causal relationships such as `delegated`, `claimed`,
`produced evidence`, `requested approval`, `retried`, and `compensated`. Edge
animation is allowed only while the corresponding event is active.

### Inspector and receipts

Selecting a node shows:

- requester and executor identities;
- execution type and locality;
- data disclosed across boundaries;
- capability grant and approval scope;
- provider or worker run identifier;
- evidence and affected resources;
- verification result;
- reversal, compensation, discard, or manual recovery action.

## Performance and lifecycle

- Dynamically import the 3D component.
- Render on demand when idle; use 30 fps balanced and 60 fps high modes only
  while visible and active.
- Pause on hidden tabs and when the voice surface is not visible.
- Cap device pixel ratio around 1–1.5.
- Use one points buffer, one line-segments buffer, and instancing for fragments.
- Precompute adjacency; do not run O(n²) neighbor searches every frame.
- Reuse geometry and materials.
- Adapt or disable bloom before reducing semantic UI responsiveness.
- Dispose WebGL resources when the session unmounts.
- Keep audio capture, transport, and visual rendering on separate lifecycles.

## Accessibility

- Keep the canvas `aria-hidden`.
- Announce state changes through a polite live region.
- Preserve semantic transcript, approval, mute, stop, and reconnect controls.
- Support complete keyboard operation without drag or pointer precision.
- Respect `prefers-reduced-motion`; use the static/2D core and remove link travel,
  orbital motion, and morphing.
- Do not flash more than three times per second.
- Keep state readable without color.
- Provide a table/list equivalent to every execution graph.
- Preserve Windows high contrast and text scaling in Companion.

## Security and privacy

- The visual component receives normalized state and audio metrics only.
- Raw microphone samples stay in the media pipeline.
- Do not include transcript or tool payloads in shader, canvas, or performance
  telemetry.
- Do not expose shell, filesystem, opener, or arbitrary network APIs through the
  renderer to support visual effects.
- All action, approval, and receipt data comes from authenticated Mission
  Control APIs.

## Intellectual property boundary

Open-source code licenses do not grant rights to Marvel or film assets,
trademarks, character names, actor likenesses or voices, music, fonts, production
art, or distinctive branded motifs.

The implementation may reuse properly licensed algorithms and code with required
notices. It must remain branded **Houston**, use original geometry and motion,
and avoid JARVIS text, MARK labels, helmet imagery, and a recognizable
arc-reactor replica.

## Rollout

1. **Design proof:** maintain the static HTML mockup and validate state grammar,
   reduced motion, and screen hierarchy.
2. **Read-only web prototype:** add a dynamically imported R3F core to a
   foreground Houston voice session with synthetic audio metrics.
3. **Media integration:** bind smoothed LiveKit input/output meters and session
   state; add WebGL and low-power fallback selection.
4. **Flight Director alpha:** wire real durable-run events into locality
   swimlanes, timeline, inspector, and list view.
5. **Companion integration:** expose the same voice state plus local capability
   and approval status in the Tauri tray surface.
6. **Optimization:** measure GPU time, battery, bundle cost, frame rate, and
   reduced-motion behavior on supported desktop and mobile devices.

## Acceptance criteria

- Every voice state has text, color, and motion definitions.
- The same state contract drives web, iOS, and Companion surfaces.
- The core responds to real smoothed audio metrics without receiving raw audio.
- Voice and approval controls remain usable with WebGL disabled.
- Reduced-motion mode has no continuous movement.
- Hidden or inactive surfaces stop rendering.
- The 3D bundle is absent from routes that do not render Houston Voice.
- Flight Director always exposes executor locality and execution custody.
- Every graph has a keyboard-operable list equivalent.
- Ported third-party code has verified licensing and required attribution.

## Open decisions

- Select the first hosted STT and TTS providers after measured evaluation.
- Define the exact low/balanced/high quality thresholds.
- Decide whether the compact chat pulse uses the 2D fallback or a shared,
  on-demand WebGL renderer.
- Decide whether historical ecosystem exploration justifies a 3D force graph.
- Finalize Houston's original synthetic voice and visual identity together.
