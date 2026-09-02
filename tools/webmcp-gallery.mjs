/**
 * Captures the submission image gallery — a set of clean 3:2 stills walking
 * through the WebMCP stylist loop, driving the tools exactly like an agent
 * would (`document.modelContext.executeTool`).
 *
 * Usage:
 *   npm run dev
 *   node tools/webmcp-gallery.mjs                 # -> docs/gallery/NN-*.png
 *   node tools/webmcp-gallery.mjs --out <dir> --url <url>
 *
 * Runs headed for real WebGPU (headless Chromium can't init the pipeline).
 */
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = arg('--url', process.env.WEBMCP_DEMO_URL || 'http://localhost:5173/');
const OUT = path.resolve(arg('--out', path.join(root, 'docs', 'gallery')));
mkdirSync(OUT, { recursive: true });

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('✗ playwright missing. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}
try {
  const r = await fetch(URL);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (err) {
  console.error(`✗ can't reach ${URL} (${err.message}). Start it: npm run dev`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: false });
// 1200x800 is exactly 3:2 — a full-viewport screenshot needs no cropping.
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(120_000);

let n = 0;
const shot = async (name) => {
  n += 1;
  const file = path.join(OUT, `${String(n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${path.relative(root, file)}`);
};
const pause = (ms) => page.waitForTimeout(ms);

const call = (name, toolArgs = {}) =>
  page.evaluate(
    async ({ name, toolArgs }) => {
      const mc = document.modelContext ?? navigator.modelContext;
      const tool = (await mc.getTools()).find((t) => t.name === name);
      const raw = await mc.executeTool(tool, JSON.stringify(toolArgs));
      const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return env.structuredContent ?? env;
    },
    { name, toolArgs },
  );

const STRIP = `(() => { const c = document.querySelector('main canvas.debug-canvas'); if (!c || !c.width) return null; const d = c.getContext('2d').getImageData(0, Math.floor(c.height*0.45), c.width, 2).data; let s = 0; for (let i = 0; i < d.length; i += 17) s += d[i]; return s; })()`;
const probe = () => page.evaluate(STRIP);
async function applyWait(garmentId, first = false) {
  const before = first ? null : await probe();
  await call('apply_tryon', { garmentId });
  if (before === null) {
    await page.waitForFunction(`(${STRIP}) !== null`);
    await pause(1500);
  } else {
    await page.waitForFunction(`(${STRIP}) !== ${before}`, null, { timeout: 30_000 });
    await pause(600);
  }
}

const GALLERY_CSS = `
  .debug-canvas { max-height: 318px !important; width: auto !important; }
  .look-card { width: 98px !important; }
  .reaction-bar { padding: 6px 8px !important; }
`;
// The scrollable region is .main-column, not the window.
const toTop = () => page.evaluate(() => { const m = document.querySelector('.main-column'); if (m) m.scrollTop = 0; });
// Bring the reaction bar + looks tray into frame (canvas top gets cut — fine
// for the shots that are about the reaction channel / the saved looks).
const toTray = () =>
  page.evaluate(() =>
    document.querySelector('.looks-panel')?.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );

try {
  // ── present-mode walkthrough ─────────────────────────────────────────────
  await page.goto(`${URL}${URL.includes('?') ? '&' : '?'}present`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    return mc && (await mc.getTools()).length >= 5;
  });
  await page.waitForSelector('.perf-stats', { state: 'attached', timeout: 150_000 });
  await page.addStyleTag({ content: GALLERY_CSS });
  // Load the model photo so the stage isn't empty (no garment yet).
  await page.click('.controls-photo button:has-text("photo-01")');
  await page.waitForFunction(`(${STRIP}) !== null`);
  await pause(1200);

  await shot('stylist-tools-live'); // model + catalog + the tool indicator

  await call('search_catalog', { occasion: 'sangeet', maxPrice: 8000 });
  await applyWait('dress-magenta-wrap-01', true);
  await shot('agent-applies-dress'); // banner + composite
  await pause(2800);

  await call('await_reaction', { reaction: 'love', note: 'perfect for the sangeet' });
  await call('save_look', { label: 'Magenta sangeet' });
  await pause(900);
  await toTray();
  await shot('reaction-and-saved-look'); // reaction bar + first card

  await applyWait('lehenga-pink');
  await toTop();
  await shot('agent-applies-lehenga'); // banner + lehenga composite
  await pause(2600);

  await call('await_reaction', { reaction: 'like' });
  await call('save_look', { label: 'Blush lehenga' });
  await pause(900);
  await toTray();
  await shot('two-saved-looks'); // the tray with both

  await call('compare_looks', { lookIds: ['look-1', 'look-2'] });
  await page.waitForSelector('.looks-compare', { timeout: 5000 });
  await pause(900);
  await shot('compare-looks'); // side-by-side modal
  await page.click('.looks-compare-header button').catch(() => {});

  await applyWait('kurti-cream-embroidered-01');
  await toTop();
  await shot('catalog-range-kurti'); // a different category on the model
  await pause(1500);

  // ── the on-device story: perf tiles + live backend ───────────────────────
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.perf-stats', { timeout: 150_000 });
  await page.addStyleTag({ content: GALLERY_CSS + '.tagline{display:none}' });
  await call('apply_tryon', { garmentId: 'dress-green-floral-01' });
  await page.waitForFunction(`(${STRIP}) !== null`);
  await pause(2500);
  // Re-run the pipeline once so the SEGMENT/POSE tiles show a warm time,
  // not the ~2.5s cold first-inference number.
  await page.click('.controls-photo button:has-text("photo-01")');
  await pause(3500);
  await shot('on-device-webgpu'); // BACKEND / SEGMENT / POSE tiles + composite
} finally {
  await browser.close();
}

const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const over = files.filter((f) => statSync(path.join(OUT, f)).size > 5_000_000);
console.log(`\n✓ ${files.length} images in ${path.relative(root, OUT)}${over.length ? `  ⚠ ${over.join(', ')} over 5 MB` : ''}`);
