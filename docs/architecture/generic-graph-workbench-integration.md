# Generic Graph workbench integration

Mission Control consumes an owner-approved committed source snapshot of
`@rsocko/generic-graph-canvas-shared-workbench`. The canonical provider is
`https://github.com/rsocko/ideation` at merged commit
`ed50b3b0313470540a58e1447e009c1620fe7f21`.

The generated payload under `vendor/generic-graph-workbench/` exposes exactly
`./controllers`, `./core`, `./host`, `./layout`, and `./react`. Its canonical
`generic-graph-workbench.snapshot.json` records schema and generator versions,
package identity, sorted exports, and the SHA-256 of every payload file.
Mission Control also pins the canonical manifest's SHA-256 independently in
the verifier, so changing a payload and rewriting its self-declared hash still
fails. Repository attributes preserve canonical LF bytes on Windows checkouts.
Vendored files are generated and must not be hand-edited.

## Operator workflow

The normal build and test flow uses only committed files:

```powershell
npm run vendor:verify
```

Synchronization is an explicit operator action. The supplied Ideation checkout
must already contain the pinned commit object; it is never a runtime or CI
dependency:

```powershell
npm run vendor:sync -- --repository C:\dev\ideation
```

`vendor:sync` extracts the generator bytes from the pinned Git object, exports
to a temporary directory, runs the upstream source-aware verification and the
Mission Control verifier, then replaces the vendor directory only after every
check passes. To advance the provider, review and update the repository-owned
pin constants first, regenerate, and commit the complete resulting provenance
change.

## Integration disposition

| Candidate area | Disposition | Evidence and retained boundary |
|---|---|---|
| Document model | Adapted | Ideation maps losslessly to a shared `mind-map` document; Project Graph maps to a `roadmap-map` projection. Mission Control schemas remain authoritative at persistence boundaries. |
| Commands | Shared | Ideation mutations commit atomic shared `replace-document` commands through `GraphDocumentController`; text outline and AI proposal batches remain one history entry. |
| Validation | Shared + host | Shared schema/profile validation gates controller commits. The existing Ideation Zod contract still validates Mission Control property grammar, one-root, node budget, and persistence payloads. |
| History and dirty semantics | Adapted | Shared controller commands and validation gate each change. Mission Control retains a bounded 30-document undo/redo ring because the provisional shared history is unbounded and each compatibility command replaces a complete document. Server workspace versions remain a separate persistence history. |
| Selection | Shared | Ideation uses controller selection and reconciliation. Project Graph uses shared click, missing-node, and hidden-descendant repair around its live projection. |
| Focus navigation | Shared + adapted | Project Graph uses `GraphNavigationController` for back/forward focus and viewport history. Its descendant-plus-direct-relation emphasis remains local because that is a specialized project/dependency presentation rule. |
| Keyboard behavior | Adapted | Shared history adds redo shortcuts and focus navigation controls. React Arborist editing, native input undo isolation, and keyboard dependency creation remain host behavior. |
| Viewport | Adapted | Shared focus locations carry React Flow-compatible viewport snapshots. React Flow measurement-aware fit and Mission Control's user-owned viewport guard remain local. |
| Placement | Adapted | Shared placements feed Ideation hierarchy layout. Project Graph drag positions remain temporary local presentation state and never mutate project hierarchy. |
| Layout | Shared for Ideation; host-owned for Project Graph | Ideation uses `createLayeredHierarchyLayout`. Project Graph retains its phase/task cluster layout because generic layering does not preserve task grids, visibility filters, dependency styling, or operational density. |
| React composition | Shared | Both surfaces compose existing renderers through shared capability-gated Canvas/Outline/Inspector regions. |
| Persistence and recovery | Host-owned | Workspace library lifecycle, autosave debounce, optimistic revisions, conflicts, recovery copies, version restore, import, and export stay in Mission Control. |
| Authorization and policy | Host-owned | Shared host adapters describe authored versus domain-projection boundaries. Existing route policy and source ownership remain the only authority for project/task mutations. |
| Property grammar | Host-owned | `key:: value`, title accelerators, typed property parsing, and lossless Mission Control metadata remain local and round-trip through adapter extensions. |
| AI expansion | Host-owned | Request context, cancellation, proposal rationale, ghost rendering, acceptance, and errors stay local; accepted proposal batches enter shared history atomically. |
| Project conversion | Host-owned | Conversion flushes the authoritative workspace and invokes existing Mission Control APIs with workspace revision provenance. |
| Queries and mutations | Host-owned | Project Graph fetches and dependency create/delete operations continue through bounded Mission Control APIs and connector sync behavior. |
| Phase/task semantics | Host-owned | Project, phase, task status, containment, dependency direction, source sync state, and details panels remain domain projections. |
| Renderers and product chrome | Host-owned | React Flow cards/edges, outline rows, property panels, workspace bar, filters, minimap, loading/error states, and navigation remain product-specific. No universal renderer was introduced. |

The dependency points only from Mission Control adapters into the vendored
package. Vendored source imports no Mission Control domain, authorization,
persistence, query, or navigation modules.
