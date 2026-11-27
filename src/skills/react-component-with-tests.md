---
name: react-component-with-tests
description: Build a typed, accessible React component with Storybook stories and Testing Library tests, matching the project's conventions.
version: 1.0.0
category: Front end
---
# React component with stories and tests

Goal: a reusable component that is typed, accessible, styled like the rest of the app, documented
with stories, and covered by behaviour-focused tests.

## Steps

1. **Learn conventions.** `find_files` for existing components similar to the requested one. Note:
   folder layout (`Button/Button.tsx` + `index.ts`?), styling (CSS modules, Tailwind, styled-components,
   plain CSS), prop naming, design tokens, test runner (Vitest/Jest + `@testing-library/react`),
   Storybook version (`.storybook/`, `*.stories.tsx`, CSF3).
2. **Define the API** in `update_plan`: props with types and defaults, controlled vs uncontrolled
   state, events (`onChange(value)`), `children`/slots, `className` passthrough, `ref` forwarding if it
   wraps a native element, variants and sizes.
3. **Implement the component:**
   - Function component with an exported `Props` interface; no `any`.
   - Native semantic elements first (`button`, `input`, `label`, `dialog`); ARIA only when needed.
   - Keyboard support and visible focus; `aria-*` for state (`aria-expanded`, `aria-pressed`).
   - Spread remaining native props onto the root element when it wraps one.
   - Memoize only when measured or when passing callbacks to heavy children.
   - Styles via the project's system and tokens; support dark mode if the app does;
     respect `prefers-reduced-motion` for animations.
4. **Stories** (only if Storybook is set up; otherwise skip and say so): `Component.stories.tsx` in
   CSF3 with `args`, one story per meaningful state (default, each variant, disabled, loading, error,
   long content, RTL if relevant). Add `play` functions for interactions if the project uses them.
5. **Tests** `Component.test.tsx`:
   - Query by role/label/text (`getByRole("button", { name: /save/i })`), not by class or test IDs.
   - Use `@testing-library/user-event` for interactions; assert visible outcomes and callbacks.
   - Cover: renders with defaults, each variant's key difference, interaction callbacks,
     keyboard interaction, disabled state, controlled updates.
   - Optional: `jest-axe`/`vitest-axe` accessibility assertion if installed.
6. Export it from the components index if the project has one.
7. Run tests, type-check, lint; run Storybook build (`npx storybook build --test` or the project
   script) if stories were added.

## Done when

- [ ] Component, stories (when Storybook exists) and tests follow project conventions.
- [ ] Props fully typed with sensible defaults; `className`/`ref` handled.
- [ ] Keyboard and screen-reader accessible.
- [ ] Tests query by role/label and cover interactions; all pass.
- [ ] Type-check and lint pass.
