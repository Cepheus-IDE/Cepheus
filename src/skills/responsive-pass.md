---
name: responsive-pass
description: Make a web UI mobile-friendly - fluid layouts, breakpoints, touch targets, viewport, images and overflow - verified at common screen widths.
version: 1.0.0
category: Front end
---
# Mobile-friendly responsive pass

Goal: the pages in scope work well from 320 px phones to wide desktops: no horizontal scrolling,
readable text, usable touch targets, and layouts that adapt.

## Steps

1. **Scope and styling system.** Identify the pages/components and how styles are written (plain CSS,
   CSS modules, Tailwind, styled-components). Reuse the existing breakpoints/tokens; `search` for
   `@media`, `sm:`/`md:` classes, theme breakpoints.
2. **Baseline:** `<meta name="viewport" content="width=device-width, initial-scale=1">` exists and
   does not disable zoom (`user-scalable=no` / `maximum-scale=1` are accessibility failures).
3. **Check each page at 320, 375, 768, 1024 and 1440 px** (devtools device mode, or Playwright
   screenshots if available: `page.setViewportSize({ width: 375, height: 800 })`). List problems in
   `update_plan`.
4. **Fix with a mobile-first approach:**
   - Layout: replace fixed widths with `max-width`, `%`, `fr`, `minmax()`; use flex-wrap and
     `grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr))`; stack columns below a breakpoint.
   - Overflow: long words/URLs (`overflow-wrap: anywhere`), wide tables (wrap in a scroll container
     or switch to stacked cards), `pre`/code blocks scroll horizontally inside their box; images and
     video `max-width: 100%; height: auto`.
   - Typography: base font size at least 16 px on mobile (prevents iOS zoom on inputs);
     `clamp()` for headings; line length 45-75 characters.
   - Navigation: collapse into a menu button with `aria-expanded`; keep primary actions reachable.
   - Touch: targets at least 44x44 px with spacing; no hover-only interactions (provide tap/focus
     alternatives); use `@media (hover: hover)` for hover effects.
   - Forms: correct `type`/`inputmode`/`autocomplete` attributes for mobile keyboards; full-width
     inputs on small screens.
   - Media: responsive images with `srcset`/`sizes` or `<picture>`; explicit width/height to avoid
     layout shift.
   - Viewport units: prefer `dvh`/`svh` over `vh` for full-height mobile sections; respect
     `env(safe-area-inset-*)` for notched devices with fixed bars.
   - Fixed/sticky elements must not cover content or inputs when the keyboard opens.
5. **Re-check every width** after the fixes, plus landscape phone (e.g. 667x375) and 200% zoom.
6. Run tests/visual tests if present.

## Done when

- [ ] Viewport meta correct and zoom not disabled.
- [ ] No horizontal page scroll at 320 px; content readable without zooming.
- [ ] Navigation and primary actions usable on phones; touch targets at least 44 px.
- [ ] Images/media/tables adapt; no layout shift from unsized images.
- [ ] Verified at 320/375/768/1024/1440 px (list what was checked and how).
