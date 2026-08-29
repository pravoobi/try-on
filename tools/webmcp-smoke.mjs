/**
 * End-to-end smoke test for the WebMCP "stylist" tool surface
 * (src/webmcp/useStylistTools.ts). Drives a real browser through the whole
 * agent loop the way an external agent would — getTools() then
 * executeTool() — and asserts every tool's response shape, plus the two
 * bits of UI the agent depends on (the reaction chips resolving
 * await_reaction, the agent-apply banner).
 *
 * This is a live-app check, not a unit test: it needs the app actually
 * served somewhere and the on-device pipeline able to run (headless
 * Chromium falls back to the wasm backend, which is slow but works).
 * searchCatalog's own logic is unit-tested separately in
 * src/webmcp/searchCatalog.test.ts.
 *
 * Usage:
 *   npm run dev                       # in another terminal (or `npm run preview`)
 *   node tools/webmcp-smoke.mjs                     # -> http://localhost:5173/
 *   node tools/webmcp-smoke.mjs --headed            # watch it happen
 *   node tools/webmcp-smoke.mjs --url https://pravoobi.github.io/try-on/
 *
 * Exit code is non-zero if any check fails. Needs `npx playwright install
 * chromium` once.
 */
import process from 'node:process';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const urlArg = args[args.indexOf('--url') + 1];
const URL = (args.includes('--url') && urlArg) || process.env.WEBMCP_SMOKE_URL || 'http://localhost:5173/';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('✗ playwright is not installed. Run:\n    npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

// Fail fast with a clear message if nothing is serving the app.
try {
  const res = await fetch(URL, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`✗ can't reach ${URL} (${err.message}).\n  Start the app first:  npm run dev`);
  process.exit(1);
}

// ---- tiny assertion harness -------------------------------------------------
let passed = 0;
let failed = 0;
const rows = [];
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    rows.push(`  ✓ ${label}`);
  } else {
    failed++;
    rows.push(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`);
  }
}
const j = (v) => JSON.stringify(v);

// ---- browser --------------------------------------------------------------
const browser = await chromium.launch({
  headless: !headed,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const page = await browser.newPage();
page.setDefaultTimeout(60_000);

const consoleErrors = [];
// The LiteRT.js wasm runtime writes its own INFO:/WARNING: log lines to
// stderr during model init, which the browser surfaces as console.error —
// not actual JS errors. Anything genuinely broken won't carry those prefixes.
const isRuntimeNoise = (t) => /^(INFO|WARNING):/.test(t.trim());
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !isRuntimeNoise(m.text())) {
    consoleErrors.push(`console.error: ${m.text()}`);
  }
});

/** getTools() + executeTool(), unwrapping the MCP envelope to the tool's own return. */
async function callTool(name, toolArgs = {}) {
  return page.evaluate(
    async ({ name, toolArgs }) => {
      const mc = document.modelContext ?? navigator.modelContext;
      const tool = (await mc.getTools()).find((t) => t.name === name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      const raw = await mc.executeTool(tool, JSON.stringify(toolArgs));
      const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return env.structuredContent ?? env;
    },
    { name, toolArgs },
  );
}

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // 1. runtime + registration
  await page.waitForFunction(
    async () => {
      const mc = document.modelContext ?? navigator.modelContext;
      if (!mc) return false;
      return (await mc.getTools()).length >= 5;
    },
    null,
    { timeout: 30_000 },
  );
  const toolNames = await page.evaluate(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    return (await mc.getTools()).map((t) => t.name).sort();
  });
  const expected = ['apply_tryon', 'await_reaction', 'compare_looks', 'save_look', 'search_catalog'];
  check(`registers all 5 tools (${toolNames.join(', ')})`, j(toolNames) === j(expected));

  // 2. search_catalog — occasion + budget (the demo-script query)
  const s1 = await callTool('search_catalog', { occasion: 'sangeet', maxPrice: 8000 });
  check(
    'search_catalog {sangeet, ≤8000} → only the magenta wrap dress',
    s1.count === 1 && s1.results?.[0]?.id === 'dress-magenta-wrap-01',
    j(s1.results?.map((r) => r.id)),
  );

  // 3. search_catalog — category alias
  const s2 = await callTool('search_catalog', { category: 'lehenga' });
  check(
    'search_catalog {category: "lehenga"} → 2 lehenga-choli',
    s2.count === 2 && s2.results.every((r) => r.category === 'lehenga-choli'),
    j(s2.results?.map((r) => r.id)),
  );

  // 4. search_catalog — impossible budget
  const s3 = await callTool('search_catalog', { maxPrice: 100 });
  check('search_catalog {≤100} → 0 results + hint', s3.count === 0 && typeof s3.hint === 'string');

  // 5. search_catalog — free-text relevance ranking
  const s4 = await callTool('search_catalog', { query: 'red lehenga for a wedding' });
  check(
    'search_catalog {query} → ranks lehenga-sangria first',
    s4.results?.[0]?.id === 'lehenga-sangria',
    j(s4.results?.slice(0, 2).map((r) => r.id)),
  );

  // 6. apply_tryon — valid id, cold (loads the default photo)
  const a1 = await callTool('apply_tryon', { garmentId: 'dress-magenta-wrap-01' });
  check(
    'apply_tryon {valid} cold → ok + loadedDefaultPhoto',
    a1.ok === true && a1.loadedDefaultPhoto === true && a1.applied?.id === 'dress-magenta-wrap-01',
    j(a1),
  );

  // agent-apply banner shows
  const flash = await page.waitForSelector('.agent-apply-flash', { timeout: 4000 }).catch(() => null);
  check('agent apply shows the "Stylist put you in …" banner', !!flash);

  // 7. apply_tryon — unknown id
  const a2 = await callTool('apply_tryon', { garmentId: 'nope-not-real' });
  check(
    'apply_tryon {unknown} → ok:false + availableIds',
    a2.ok === false && Array.isArray(a2.availableIds) && a2.availableIds.length === 8,
    j(a2),
  );

  // wait for the composited preview so save_look has a canvas to snapshot
  await page.waitForFunction(
    () => {
      const c = document.querySelector('main canvas.debug-canvas');
      return !!c && c.width > 0;
    },
    null,
    { timeout: 45_000 },
  );

  // 8. save_look
  const l1 = await callTool('save_look', { label: 'magenta wrap' });
  check(
    'save_look → ok, look-1, resolves garment name',
    l1.ok === true && l1.look?.id === 'look-1' && l1.look?.garments?.[0]?.name === 'Magenta Wrap Maxi Dress',
    j(l1),
  );

  // 9. second look
  await callTool('apply_tryon', { garmentId: 'dress-navy-floral-01' });
  await page.waitForTimeout(2500);
  const l2 = await callTool('save_look', { label: 'navy floral' });
  check('save_look again → look-2', l2.ok === true && l2.look?.id === 'look-2', j(l2));

  // 10. compare_looks — real + missing id
  const c1 = await callTool('compare_looks', { lookIds: ['look-1', 'look-2', 'look-404'] });
  check(
    'compare_looks → comparing 2, reports missing',
    c1.ok === true && c1.comparing?.length === 2 && j(c1.missing) === j(['look-404']),
    j(c1),
  );
  const modalOpen = await page.waitForSelector('.looks-compare', { timeout: 3000 }).catch(() => null);
  check('compare_looks opens the side-by-side modal', !!modalOpen);
  await page.click('.looks-compare-header button').catch(() => {}); // close it

  // 11. compare_looks — all unknown
  const c2 = await callTool('compare_looks', { lookIds: ['ghost'] });
  check(
    'compare_looks {all unknown} → ok:false + availableLookIds',
    c2.ok === false && Array.isArray(c2.availableLookIds),
    j(c2),
  );

  // 12. await_reaction — blocks, then a chip tap resolves it with structured data
  await page.evaluate((toolArgs) => {
    const mc = document.modelContext ?? navigator.modelContext;
    window.__smokeReaction = (async () => {
      const tool = (await mc.getTools()).find((t) => t.name === 'await_reaction');
      const raw = await mc.executeTool(tool, JSON.stringify(toolArgs));
      const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return env.structuredContent ?? env;
    })();
  }, { timeoutSeconds: 30 });
  const pendingUi = await page.waitForSelector('.reaction-bar.pending', { timeout: 5000 }).catch(() => null);
  check('await_reaction blocks → reaction bar shows the "waiting" state', !!pendingUi);
  await page.fill('.reaction-note', 'love the print, want it shorter');
  await page.click('.reaction-chip-try_another');
  const reaction = await page.evaluate(() => window.__smokeReaction);
  check(
    'await_reaction resolves with { reaction, note, guidance }',
    reaction.reaction === 'try_another' &&
      reaction.note === 'love the print, want it shorter' &&
      typeof reaction.guidance === 'string',
    j(reaction),
  );

  // 13. await_reaction — timeout path
  const t0 = Date.now();
  const timedOut = await callTool('await_reaction', { timeoutSeconds: 5 });
  check(
    'await_reaction times out → reaction: "none"',
    timedOut.reaction === 'none' && Date.now() - t0 >= 4500,
    `${j(timedOut)} after ${Date.now() - t0}ms`,
  );

  // 14. no page errors along the way
  check('no console errors / page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (err) {
  failed++;
  rows.push(`  ✗ threw: ${err.message}`);
} finally {
  await browser.close();
}

console.log(`\nWebMCP smoke — ${URL}\n${rows.join('\n')}`);
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
