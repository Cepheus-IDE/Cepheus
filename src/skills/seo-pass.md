---
name: seo-pass
description: Technical and on-page SEO pass for a website - metadata, headings, structured data, sitemap, robots, performance and crawlability.
version: 1.0.0
category: Front end
---
# SEO pass for a website

Goal: every public page is crawlable, has unique and descriptive metadata, correct semantics and
structured data, and the site exposes a sitemap and robots rules.

## Steps

1. **Identify the rendering model:** static HTML, SSR/SSG framework (Next.js, Nuxt, Astro, SvelteKit,
   Remix, Hugo), or a client-only SPA. Client-only SPAs are a crawlability risk: recommend
   prerendering/SSR for public pages and say so in the report.
2. **Inventory public pages/routes** (`find_files` in `pages/`, `app/`, `src/routes/`, `content/`,
   `*.html`) in `update_plan`.
3. **Per page, check and fix:**
   - `<title>`: unique, 50-60 characters, primary topic first, brand last.
   - `<meta name="description">`: unique, 120-160 characters, describes the page.
   - Exactly one `<h1>`; logical `h2`/`h3` hierarchy; descriptive link text (no "click here").
   - `<link rel="canonical">` with the absolute preferred URL; no duplicate pages without canonical.
   - `<html lang>` set; `hreflang` alternates if the site is multilingual.
   - Open Graph (`og:title`, `og:description`, `og:image` 1200x630, `og:url`, `og:type`) and
     `twitter:card`.
   - Images: meaningful `alt`, compressed modern formats, explicit dimensions, lazy loading below the fold.
   - Use the framework's metadata API (Next.js `metadata`/`generateMetadata`, Nuxt `useSeoMeta`,
     Astro layout props) instead of hand-editing heads.
4. **Structured data:** add JSON-LD (`<script type="application/ld+json">`) that matches visible
   content: `Organization`/`WebSite` on the home page, `Article`/`BlogPosting`, `Product`,
   `BreadcrumbList`, `FAQPage` where applicable.
5. **Site-level files:**
   - `robots.txt` allowing public content, disallowing admin/private paths, linking the sitemap.
   - `sitemap.xml` generated at build time (framework plugin or script) with absolute URLs and `lastmod`.
   - Custom 404 page returning HTTP 404; redirects as 301 for moved pages.
   - No `noindex` left on production pages by accident (`search` for `noindex`).
6. **Performance signals (Core Web Vitals):** run Lighthouse SEO + performance if Chrome is available
   (`npx lighthouse <url> --only-categories=seo,performance --chrome-flags="--headless"`); fix LCP image
   priority, CLS from unsized media, render-blocking resources.
7. **URLs:** lowercase, hyphenated, descriptive, stable; trailing-slash policy consistent.

## Done when

- [ ] Every public page has a unique title, description, one h1 and a canonical URL.
- [ ] Open Graph/Twitter tags and valid JSON-LD on key page types.
- [ ] robots.txt and sitemap.xml exist and reference each other; no accidental noindex.
- [ ] Lighthouse SEO score checked (or noted unavailable) and top issues fixed.
- [ ] Report lists changes per page and remaining recommendations (e.g. SSR for SPA routes).
