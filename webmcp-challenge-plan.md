# WebMCP Challenge — Try-On Stylist Plan

Repo: https://github.com/pravoobi/try-on
Deadline: Sept 3, 1:00 PM PT (= Sept 4, 1:30 AM IST) — submissions close, no late entries.

## The pitch

An agent-assisted styling loop on top of the existing on-device virtual try-on
app. The agent searches the catalog and applies try-ons; the human reacts and
steers, because only the human can judge fit and vibe. No server — WebMCP
tools are plain JS functions the page already has, exposed via
`navigator.modelContext.registerTool()`.

## Decisions locked in

- **Photo-based, not webcam.** Deterministic state for save/compare, no
  camera-permission friction for judges, no need to touch the live pipeline.
  Webcam mode stays in the app as an existing toggle, just outside the WebMCP
  tool flow — fine to show off in the demo video, not part of the judged loop.
- **Dress-only catalog for the demo.** Pants/shirts/tshirts/shorts/lehengas
  have real pipeline support but uneven anchor quality — out of scope this
  week. Praveen is picking the dresses that already fit well and removing the
  rest from the demo catalog.
- **Extend the existing app, don't rebuild.** The on-device (segmentation +
  pose + TPS warp, WebGPU) pipeline is the differentiator; a week isn't enough
  to rebuild that from scratch.

## Open question — SETTLED (Day 1)

Broadened the judged catalog from 3 dresses to **8 curated items**: 3 dresses,
3 kurtis, 2 lehengas (all already fit well; the ill-fitting pants/shirts/
tshirts/shorts were pruned from `catalog.json`). Kurtis + lehengas make the
"Sangeet"/"wedding" demo script land and give `search_catalog` real breadth
without needing new photography. Praveen to eyeball each of the 8 on a test
photo and flag any that warp badly.

Each entry now carries `meta.name` / `meta.price` (₹) / `meta.occasion[]` /
`meta.color` — the fields `search_catalog` filters on.

## WebMCP tool surface

Registered via `@mcp-b/global` (installs `document.modelContext`, the current
WebMCP surface; the deprecated `navigator.modelContext` still works as a
fallback and Chromium's native impl is used when the flag is on) +
`@mcp-b/react-webmcp`'s `useWebMCP`. Each tool points at logic that already
exists in `App.tsx` — no new business logic, just a callable entry point.

- `search_catalog({ query?, occasion?, color?, category?, maxPrice? })` →
  filters the curated catalog (`src/webmcp/searchCatalog.ts`), returns matches
  with id/name/price/color/occasion, ranked by query relevance.
- `apply_tryon({ garmentId })` → calls the existing garment-select handler
  against the loaded demo photo; auto-loads the first test photo if none is
  loaded; composites and updates the preview.
- `save_look({ label? })` → snapshots the composited photo-mode canvas (down-
  scaled PNG) + worn garment ids into the in-memory looks tray
  (`src/hooks/useLooks.ts`); returns the new `look-N` id + the full id list.
- `compare_looks({ lookIds })` → selects saved looks and opens the side-by-side
  comparison modal (`src/components/LooksPanel.tsx`); reports any missing ids.
- `await_reaction({ timeoutSeconds? })` → blocks until the human taps a reaction
  chip (Love it / Good / Try another / Not this) with an optional note, or times
  out; returns `{ reaction, note, guidance }` (`src/hooks/useReaction.ts`).

The looks tray + comparison + reaction chips are also human-drivable: a
"＋ save current look" button, a per-card "compare" toggle, and the reaction
bar run the same loop the agent does.

## Testing the tools

- `npm run smoke:webmcp` — `tools/webmcp-smoke.mjs` drives a headless browser
  through the full `getTools()` → `executeTool()` loop and asserts all five
  tools' responses (17 checks). Needs the app served (`npm run dev`) and
  `npx playwright install chromium` once. `--headed` / `--url <deployed>` flags.
- Browser console on the running app: `document.modelContext.getTools()` /
  `executeTool(tool, JSON.stringify(args))` — the tool's own return is under
  the envelope's `.structuredContent`.
- Real agent: the **WebMCP Bridge** Chrome extension bridges the page's tools
  to a local MCP client (Claude Code / Claude Desktop / Cursor); the **WebMCP
  Inspector** extension gives a no-client panel. Native path: Chrome 146+
  with the WebMCP flag — `@mcp-b/global` defers to it.

## Day-by-day

- [x] **Day 1 (Fri, Aug 28)** — Catalog pruned to 8 curated items (3 dress,
      3 kurti, 2 lehenga); ill-fitting categories dropped. `meta.name` /
      `price` / `occasion` / `color` added to `schema.ts` (all optional —
      user uploads omit them) + every catalog entry. `searchCatalog.ts` pure
      fn + 8 unit tests.
- [x] **Day 2 (Sat, Aug 29)** — `search_catalog` + `apply_tryon` registered
      via `@mcp-b/global` (WebMCP polyfill; passes through to native
      `document.modelContext` when present) + `@mcp-b/react-webmcp`'s
      `useWebMCP`. Wired in `src/webmcp/useStylistTools.ts`, consumed by
      `App.tsx`. `apply_tryon` auto-loads the first test photo when none is
      picked so the agent flow works cold. Verified end-to-end in Chrome:
      `getTools()` lists both, `executeTool` runs the search→apply loop, dress
      composites on the model. Small "AI stylist tools live" status indicator
      with per-tool call counts.
- [x] **Day 3 (Sun, Aug 30)** — `save_look` + `compare_looks` registered.
      `src/hooks/useLooks.ts` (in-memory tray, not persisted) +
      `src/components/LooksPanel.tsx` (thumbnail strip under the canvas +
      side-by-side comparison modal, reusing the `.modal-overlay` pattern) +
      `snapshotCanvas.ts` (downscaled data-URL of the composited canvas, via a
      forwarded ref on the photo-mode `DebugCanvas`). Also human-drivable
      (save button + per-card compare toggle). Verified E2E in Chrome:
      search→apply→save→apply→save→compare renders both looks side by side;
      missing look ids reported, not errored.
- [x] **Day 4 (Mon, Aug 31)** — Human-agent loop polish. (1) Visible apply:
      when the *agent* (not a manual picker tap) applies a try-on, the
      preview gets a border-sweep glow + a "🎨 Stylist put you in <name>"
      banner (`.tryon-stage` / `.agent-apply-flash`), auto-clearing after
      ~3.5s. (2) Structured reaction channel: `src/hooks/useReaction.ts` +
      `src/components/ReactionBar.tsx` — four chips (Love it / Good / Try
      another / Not this) + an optional note. New `await_reaction` tool
      blocks the agent until the human taps a chip (or a fresh unconsumed
      one exists), returning `{ reaction, note, guidance }`; the bar shows a
      pulsing "the stylist is waiting for your reaction" state while blocked.
      `apply_tryon`'s response now tells the agent to call `await_reaction`.
      Verified E2E in Chrome: blocking + resolve, note passthrough,
      fresh-reaction-returns-immediately, and timeout→`none`.
- [x] **Day 5 (Tue, Sep 1 — done early, Aug 31)** — Verified end-to-end in
      ChatGPT's in-app browser (Codex): prompt `use sitetools: style me for a
      sangeet under 8k` drove search_catalog → apply_tryon → save_look →
      compare_looks, agent respected the ₹8k filter and deferred to the human's
      final pick. Gap found: `await_reaction` never fired because the human
      types the reaction and ChatGPT reads it from chat. Fix (commit 28fca9a):
      `await_reaction` is now dual-mode — pass `reaction` (love/like/
      try_another/reject) + `note` to log a chat reaction to the app's
      reaction bar and get guidance immediately, or omit it to block for a chip
      tap. Response carries `source` (chat/chip/timeout). Smoke test → 19
      checks. Deployed + live.
- [x] **Day 6 (Wed, Sep 2)** — ~~README rewrite~~ ✅ (ee7016f). ~~demo GIF~~ ✅
      (42443c7). ~~thumbnail~~ ✅ (29bc470). ~~`?present` clean mode~~ ✅
      (f457d82). ~~test-photo rename~~ ✅ (3f26606 — photo-01 = hero, in order).
      ~~submission story~~ ✅ (`docs/submission.md`, Devpost format).
      ~~8-image gallery~~ ✅ (645d631 — `docs/gallery/`, `npm run gallery:webmcp`).
      Name = "Virtual Try-On + AI Stylist"; pitch, Built-with tags, Try-it-out
      links all drafted. **Left:** paste it into the Devpost form; optional
      screen-recorded video (open `…/?present`).
- [ ] **Day 7 (Thu, Sep 3)** — Submit well before 1 PM PT / 1:30 AM IST
      (Sep 4) — don't cut it close across the timezone gap.

## Judging criteria (for reference while building)

Usefulness, originality, execution, thoughtful use of WebMCP, and quality of
the human-agent experience. The last one is the easiest to under-invest in —
budget real time for Day 4.
