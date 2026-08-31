/**
 * Captures the submission thumbnail: one clean 3:2 frame of the agent having
 * just applied a try-on — the "AI stylist tools live" indicator, the
 * "Stylist put you in …" banner, the composited garment, and the reaction
 * chips. Drives the WebMCP tools exactly like an agent would.
 *
 * Usage:
 *   npm run dev
 *   node tools/webmcp-thumb.mjs                 # -> docs/thumbnail.png
 *   node tools/webmcp-thumb.mjs --out <path> --url <url>
 *
 * Runs headed for real WebGPU (headless Chromium can't init the pipeline).
 */
import { existsSync, statSync } from 'node:fs';
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
const OUT = path.resolve(arg('--out', path.join(root, 'docs', 'thumbnail.png')));

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

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    return mc && (await mc.getTools()).length >= 5;
  });
  await page.waitForSelector('.perf-stats', { timeout: 150_000 }).catch(() => {
    throw new Error('pipeline never became ready — run with a real GPU / headed.');
  });

  await page.addStyleTag({
    content: `
      .tagline { display: none !important; }
      .error { display: none !important; }
      .perf-stats { display: none !important; }
      .status:not(.webmcp-status) { display: none !important; }
      .webmcp-status { margin-top: 4px !important; }
      main { margin: 6px 0 !important; }
      .debug-canvas { max-height: 452px !important; width: auto !important; }
      .controls { margin: 5px 0 !important; }
    `,
  });
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.controls button, .controls input[type=file]')) {
      if (/Enhance \(3D\)/.test(b.textContent || '') || b.type === 'file') {
        b.closest('.controls')?.style.setProperty('display', 'none', 'important');
      }
    }
  });

  await call('search_catalog', { occasion: 'sangeet', maxPrice: 8000 });
  await call('apply_tryon', { garmentId: 'dress-magenta-wrap-01' }); // cold: awaits the pipeline
  await page.waitForFunction(() => {
    const c = document.querySelector('main canvas.debug-canvas');
    return c && c.width > 0;
  });
  await page.waitForTimeout(3500); // the garment warps on
  await call('apply_tryon', { garmentId: 'dress-magenta-wrap-01' }); // re-fires the banner, no re-composite
  await page.waitForTimeout(900);

  await page.screenshot({ path: OUT }); // 2400x1600 = 3:2
} finally {
  await browser.close();
}

if (!existsSync(OUT)) {
  console.error('✗ no screenshot written');
  process.exit(1);
}
const kb = Math.round(statSync(OUT).size / 1024);
console.log(`\n✓ ${path.relative(root, OUT)} — ${kb} KB (2400×1600, 3:2)`);
if (kb > 5000) console.warn('  ⚠ over 5 MB — re-encode as JPG');
