---
name: accessibility-audit
description: Audit React/HTML UI against WCAG 2.2 AA and fix issues in semantics, keyboard access, focus, labels, contrast and motion.
version: 1.0.0
category: Front end
---
# Accessibility audit (WCAG 2.2 AA, React / HTML)

Goal: the audited pages/components are usable by keyboard and screen-reader users and meet
WCAG 2.2 AA. Fix issues directly when they are local and safe; list the rest.

## Steps

1. **Scope**: the components/pages the user named, or the main routes. `find_files` for `*.tsx`,
   `*.jsx`, `*.vue`, `*.html` in that area.
2. **Automated pass** (if a dev server can run):
   - `npx @axe-core/cli http://localhost:3000 --exit` or, with Playwright present,
     `@axe-core/playwright` in a quick script.
   - If `eslint-plugin-jsx-a11y` is installed, run `npx eslint . --ext .jsx,.tsx`.
   Automated tools catch about a third of issues; continue with the manual review.
3. **Manual code review checklist:**
   - **Semantics (1.3.1, 4.1.2):** buttons are `<button>`, links are `<a href>`; no clickable `div`
     without `role`, `tabIndex=0` and key handlers. Headings in order (`h1` then `h2`...). Landmarks:
     `header`, `nav`, `main`, `footer`. Lists use `ul/ol`. Tables have `th` + `scope`.
   - **Names and labels (1.1.1, 2.5.3, 3.3.2):** every `img` has meaningful `alt` (empty `alt=""` for
     decoration); icon-only buttons have `aria-label`; every input has a `<label htmlFor>`; error
     messages linked with `aria-describedby` and announced (`role="alert"` or live region).
   - **Keyboard (2.1.1, 2.1.2, 2.4.3):** everything operable with Tab / Shift+Tab / Enter / Space /
     Escape / arrows; no keyboard traps; logical tab order (no positive `tabIndex`).
   - **Focus (2.4.7, 2.4.11 new in 2.2):** visible focus ring (do not remove `outline` without a
     replacement); focused element not hidden behind sticky headers; modals trap focus while open and
     return it to the trigger on close.
   - **Contrast (1.4.3, 1.4.11):** text 4.5:1 (3:1 for large text), UI component borders/icons 3:1.
     Check theme tokens in CSS.
   - **Target size (2.5.8 new in 2.2):** interactive targets at least 24x24 CSS px or spaced.
   - **Dragging (2.5.7 new in 2.2):** any drag interaction has a single-pointer alternative.
   - **Motion (2.3.3):** honor `prefers-reduced-motion`; no auto-playing animation longer than 5 s.
   - **Dynamic content (4.1.3):** toasts/status updates use `aria-live="polite"`.
   - **Forms (3.3.7, 3.3.8 new in 2.2):** no redundant re-entry; authentication without
     cognitive tests (allow paste in password fields).
   - **Language (3.1.1):** `<html lang="...">` set.
4. **Fix** with minimal, idiomatic changes (prefer native elements over ARIA). Track each in
   `update_plan`.
5. Re-run the automated checks and the test suite.

## Report format

```
| WCAG | Severity | Location | Issue | Fix |
|------|----------|----------|-------|-----|
| 2.4.7 | High | Button.css:12 | outline: none on :focus | :focus-visible ring 2px |
```

## Done when

- [ ] Automated scan run (or noted as unavailable) and its violations addressed.
- [ ] Manual checklist covered for every component in scope.
- [ ] All interactive elements reachable and operable by keyboard with visible focus.
- [ ] Fixed issues listed with WCAG criterion; remaining issues listed with suggested fixes.
- [ ] Tests still pass.
