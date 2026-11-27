---
name: performance-audit
description: Measure and improve performance of a web front end and/or a Node.js back end, with before/after numbers.
version: 1.0.0
category: Performance
---
# Performance audit (web + Node)

Goal: find the biggest measurable bottlenecks, fix the top ones, and prove the improvement with
numbers. Never optimize without a measurement.

## Steps

1. **Establish a baseline.** Ask or infer the user-facing problem (slow page load, slow API route,
   high memory). Record current numbers before touching code.
   - Build size: `npm run build` and note the bundle sizes printed; `npx vite-bundle-visualizer`
     or `npx source-map-explorer dist/**/*.js` when available.
   - Lighthouse (if Chrome is installed): `npx lighthouse http://localhost:3000 --only-categories=performance --output=json --output-path=./lh.json --chrome-flags="--headless"`
     and read LCP, INP/TBT, CLS, total byte weight.
   - API latency: `npx autocannon -c 20 -d 15 http://localhost:3000/api/route` (p50/p99, req/s).
   - Node CPU profile: `node --cpu-prof server.js` then load the route; inspect the `.cpuprofile`
     hottest functions. Memory: `node --heapsnapshot-signal=SIGUSR2` or `--inspect`.
2. **Front-end checklist:**
   - Largest bundles: heavy libraries imported whole (`lodash`, `moment`, icon packs); use per-method
     imports or lighter alternatives; code-split routes with dynamic `import()`.
   - Images: correct size, modern formats (AVIF/WebP), `loading="lazy"`, explicit `width`/`height`
     (prevents CLS), `fetchpriority="high"` on the LCP image.
   - Render-blocking CSS/JS in `<head>`; fonts with `font-display: swap` and preload.
   - React: unnecessary re-renders (state too high, new object/array props every render), missing
     `key`s, huge lists without virtualization, expensive work in render without `useMemo`.
   - Network waterfalls: sequential fetches that could be parallel; missing HTTP caching headers.
3. **Node back-end checklist:**
   - N+1 database queries (query in a loop); missing indexes (`EXPLAIN ANALYZE` the slow query).
   - Synchronous I/O (`fs.readFileSync`, `JSON.parse` of huge payloads, `crypto` sync) on the
     request path; CPU-heavy work that should go to a worker.
   - Sequential `await` in loops where `Promise.all` (with a concurrency limit) is safe.
   - Missing caching of expensive, rarely changing results; missing compression; huge responses
     without pagination.
   - Memory leaks: unbounded maps/caches, listeners never removed, closures capturing big objects.
4. **Rank findings by impact / effort**, put the top 3 to 5 into `update_plan`.
5. **Fix one at a time**, re-measure after each with the same command, keep the change only if the
   number improves and tests still pass.

## Report format

```
| Change | Metric | Before | After |
|--------|--------|--------|-------|
| Lazy-load chart route | main.js gzip | 412 kB | 236 kB |
```

## Done when

- [ ] A baseline was measured with a repeatable command.
- [ ] Top bottlenecks are listed with evidence (profile, bundle report, query plan).
- [ ] Applied fixes show before/after numbers from the same measurement.
- [ ] Tests and build still pass; no behaviour change.
- [ ] Remaining opportunities are listed for the user.
