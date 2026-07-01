# OpenCode Desktop — Dashboard Visual Redesign

User-supplied prompt (2026-06-30). Goal: bring the existing OpenCode
Desktop dashboard up to the dark mission-control mockup look.

## Scope

- Pure CSS / component-structure polish. No business logic changes.
- Preserve existing session / project / goal behavior and data sources.
- Reusable primitives (panels, buttons, sidebar rows, stat cards, rail
  actions, session rows, attention items). No one-off hardcoded colors.

## Why this file exists

The user pasted the full spec into chat as a prompt template. They wanted
it preserved somewhere Mavis / future sessions can read it, since live
chat context rolls over. This file is that preserved copy.

## Source of truth (verbatim from the user)

> Goal: Make the current dashboard match the new dark mission-control
> mockup: premium dark shell, soft gradients, subtle borders, clean
> three-column layout, polished sidebar, hero panel, stat cards, live
> board, right command rail, and attention queue.
>
> Do not change business logic. Do not fake data. Preserve existing
> session / project / goal behavior. This is primarily CSS/component
> structure polish.
>
> Implement using reusable dashboard components and design tokens. Avoid
> hardcoded one-off colors and spacing.

### Implementation order (per the user)

1. Add design tokens.
2. Create shared panel / button primitives.
3. Refactor dashboard shell layout.
4. Polish sidebar.
5. Polish hero panel.
6. Polish stats row.
7. Polish live board.
8. Polish right rail.
9. Polish attention queue.
10. Verify no business logic changed.
11. Capture screenshot.

### Design tokens

```css
:root {
  --bg-app: #050812;
  --bg-sidebar: rgba(9, 14, 26, 0.92);
  --bg-panel: rgba(14, 20, 34, 0.76);
  --bg-panel-strong: rgba(19, 26, 43, 0.88);
  --bg-panel-soft: rgba(255, 255, 255, 0.035);
  --bg-panel-hover: rgba(255, 255, 255, 0.065);

  --border-subtle: rgba(255, 255, 255, 0.08);
  --border-medium: rgba(255, 255, 255, 0.14);
  --border-strong: rgba(255, 255, 255, 0.22);

  --text-primary: rgba(250, 252, 255, 0.96);
  --text-secondary: rgba(204, 212, 229, 0.78);
  --text-muted: rgba(162, 173, 194, 0.58);
  --text-faint: rgba(162, 173, 194, 0.38);

  --accent-purple: #7c5cff;
  --accent-purple-soft: rgba(124, 92, 255, 0.18);
  --accent-blue: #6aa7ff;
  --accent-green: #45d483;
  --accent-orange: #f5a524;
  --accent-pink: #ff5c93;
  --accent-red: #ff5573;

  --shadow-soft: 0 18px 60px rgba(0, 0, 0, 0.38);
  --shadow-card: 0 12px 32px rgba(0, 0, 0, 0.26);
  --shadow-glow-purple: 0 0 42px rgba(124, 92, 255, 0.18);

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 22px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 32px;
  --space-8: 40px;

  --sidebar-width: 342px;
  --right-rail-width: 336px;
}
```

(Full CSS/JSX for shell, sidebar, hero, stat cards, live board, right
rail, attention queue was provided inline in the user's message — too
long to repeat here. See the original message context or this file's
prior revision for the verbatim body. The implementation will follow
the same token names and class shapes.)

## Don'ts

- No bright borders around every container.
- No neon everywhere.
- No flattened gray rectangles.
- Right rail does NOT scroll internally unless content truly overflows.
- Preserve existing callbacks and data sources.
- Semantic buttons for clickable rows.
- Long names truncate cleanly.
- Layout must work at 1280px width and larger.
