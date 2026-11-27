---
name: add-i18n
description: Add internationalization to an app - pick or reuse an i18n library, extract hard-coded strings into message catalogs and wire locale switching.
version: 1.0.0
category: Front end
---
# Add internationalization (i18n)

Goal: user-visible strings come from message catalogs, a second locale works end to end, and
dates/numbers/plurals are locale-aware.

## Steps

1. **Detect the stack and any existing i18n.** `search` for `i18next`, `react-intl`, `next-intl`,
   `vue-i18n`, `gettext`, `fluent`, `t(`, `formatMessage`. If one exists, extend it; never add a
   second library.
2. **Choose a library** when none exists (ask the user if unsure):
   - React: `i18next` + `react-i18next`; Next.js App Router: `next-intl`; Vue: `vue-i18n`;
     Python: `gettext`/Babel; Rust: `fluent`.
   Install it with the project's package manager (`npm i i18next react-i18next`).
3. **Create the structure:** `locales/en.json` (source) and one target locale (e.g. `locales/es.json`),
   plus an `i18n.ts` init module with a fallback locale and missing-key logging in development.
4. **Extract strings** file by file (track in `update_plan`):
   - Replace literals in JSX/templates, `placeholder`, `title`, `aria-label`, `alt`, toast and error
     messages with `t("area.key")`.
   - Key naming: `feature.component.purpose` (`checkout.summary.totalLabel`). Stable, not the English text.
   - Use interpolation, never concatenation: `t("cart.items", { count })`, not `"Items: " + count`.
   - Plurals through the library's plural rules (`_one`/`_other` in i18next, ICU `{count, plural, ...}`).
   - Do not translate: log messages, CSS classes, keys sent to APIs, test IDs.
5. **Locale-aware formatting:** replace manual date/number formatting with `Intl.DateTimeFormat`,
   `Intl.NumberFormat`, `Intl.RelativeTimeFormat` using the active locale.
6. **Locale switching:** detect from user setting, then `navigator.language`, then fallback; persist the
   choice; update `<html lang>`; support RTL (`dir="rtl"`) if an RTL locale is planned (use logical CSS
   properties like `margin-inline-start`).
7. **Fill the second locale** with real translations or clearly marked placeholders the user can hand
   to translators.
8. **Verify:** run the app in both locales; search for remaining hard-coded strings
   (e.g. `search` regex `>[A-Z][a-z]+ [a-z]+<` in JSX); run tests and type-check.

## Done when

- [ ] One i18n library, initialized once, with fallback locale.
- [ ] No user-visible hard-coded strings left in the converted scope.
- [ ] Plurals and interpolation use the library; dates/numbers use `Intl`.
- [ ] Locale can be switched and is persisted; `<html lang>` follows it.
- [ ] Source and target catalogs have identical key sets.
- [ ] Tests/type-check pass.
