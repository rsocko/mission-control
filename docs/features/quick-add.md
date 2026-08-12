---
title: Quick Add
sidebar_label: Quick Add
---

# Quick Add

Quick Add creates tasks from the global toolbar without leaving the current view. Press `N` when focus is not in another input to focus the bar, or press `Ctrl+K` (`Cmd+K` on macOS) and use the **Create task** action in the command palette.

Both entry points use the same parser and create-preview behavior.

## Task grammar

| Syntax | Result | Example |
|--------|--------|---------|
| `#tag` | Adds one or more tags | `Draft launch notes #planning` |
| `!critical`, `!high`, `!medium`, `!low` | Sets priority | `Fix production alert !critical` |
| `!0` through `!3` | Sets priority from critical through low | `Review backlog !2` |
| `^1` through `^5` | Sets effort from XS through XL | `Refactor parser ^4` |
| `~30m`, `~1.5h` | Sets estimated duration | `Review proposal ~30m` |
| `+Project` | Assigns an existing hub project | `Draft brief +Website` |
| `/due:<date>` | Sets a due date explicitly | `Send report /due:next Friday` |
| `@work`, `@personal`, `@github`, `@todo` | Selects a compatible destination | `File follow-up @work` |
| Recurrence phrase | Sets recurrence | `Review metrics every Monday` |

Typeahead menus resolve tags, priorities, effort, lists, and projects. Project names selected from typeahead are stored by project ID; an unknown `+Project` blocks creation instead of silently discarding the assignment.

## Safe date detection

Explicit `/due:` commands apply immediately. A natural-language date at the end of ordinary text is offered as a suggestion:

```text
Buy a birthday gift next Saturday
```

Quick Add keeps the complete title while editing and shows **Use Next Saturday**. Clicking the suggestion applies it immediately; creating the task also accepts any visible date suggestion. The due date is then applied and, unless title preservation is enabled, the date phrase is removed from the saved title. Escape a date phrase with `\` or disable natural-language date suggestions to keep it as ordinary title text.

## Title preservation

By default, recognized metadata tokens are removed from the saved title after their values are applied. Enable **Preserve metadata tokens** under **Settings > Other > Quick Add parsing** to retain the original tokens in the title.

The same settings include **Natural-language date suggestions**, which can disable trailing-date detection while leaving explicit `/due:` commands available.

Preferences apply to the toolbar, Ctrl+K creation, desktop Settings, and mobile Settings.

## Multiple tasks

Quick Add supports:

- Newline-separated paste
- `;;` as an explicit inline separator
- Markdown task lists and tables
- Nested lists converted to parent tasks and subtasks
- Suggested splitting for recognized compound actions

Pending tasks appear as editable chips before creation.

## View context

The global bar inherits useful defaults from the active view. For example, tasks created from My Day are added to My Day, and list-filtered views use the active list unless the destination is changed.
