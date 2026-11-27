---
name: add-typescript-types
description: Convert JavaScript files to TypeScript (or add JSDoc types) incrementally, with strict, accurate types and no runtime changes.
version: 1.0.0
category: Code quality
---
# Add TypeScript types to JavaScript

Goal: the chosen JS files are typed accurately and type-check under the project's settings, with no
runtime behaviour change and minimal `any`.

## Steps

1. **Assess the setup.**
   - Is there a `tsconfig.json`? If not, create one appropriate for the project
     (`"strict": true`, `"allowJs": true`, `"checkJs": false`, `"noEmit": true` when a bundler builds,
     correct `module`/`moduleResolution`/`target`, `"jsx"` if React).
   - Is `typescript` installed? If not: `npm i -D typescript` plus needed `@types/*`
     (`@types/node`, `@types/react`...).
   - Ask the user: rename to `.ts`/`.tsx`, or keep `.js` with JSDoc + `// @ts-check`?
2. **Order the work** leaves-first: utilities and modules with no local imports first, then the
   modules that import them. Put the list in `update_plan`.
3. **For each file:**
   1. Rename with `git mv file.js file.ts` (`.tsx` if it contains JSX) so history is kept.
   2. Type function parameters and return types of exported functions explicitly.
   3. Model data with `interface`/`type`; use unions and literal types for known string values;
      `readonly` where data is not mutated.
   4. Prefer `unknown` + narrowing over `any`; when `any` is unavoidable, leave a short comment why.
   5. Type external data at the boundary (API responses, `JSON.parse`) and validate it if a schema
      library (zod, valibot) exists in the project.
   6. Fix real bugs the compiler finds, but tell the user; do not change behaviour silently.
   7. Avoid non-null assertions `!` unless the invariant is obvious; avoid `as` casts that lie.
4. **Type-check after each file:** `npx tsc --noEmit`. Keep the error count going down.
5. Update build/test config if needed (jest `ts-jest`/`babel`, vitest works out of the box, eslint
   `@typescript-eslint`), and `package.json` `types` field for libraries.
6. Run the test suite and the build.

## Done when

- [ ] `npx tsc --noEmit` passes with zero errors for the converted scope.
- [ ] Exported functions have explicit parameter and return types.
- [ ] No new `any` without a justification comment; no `@ts-ignore` without a reason.
- [ ] Tests and build pass; runtime behaviour unchanged.
- [ ] Summary lists converted files and bugs the types revealed.
