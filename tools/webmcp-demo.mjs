/**
 * Records the README demo: an agent driving the WebMCP stylist loop
 * (search → apply → react → save → apply → react → save → compare) while
 * the app visibly responds. Drives the tools exactly the way an external
 * agent would — `document.modelContext.executeTool(...)` — and screenshots
 * the key states, then stitches them into a slideshow GIF with ffmpeg.
 *
 * Usage:
 *   npm run dev                     # in another terminal
 *   node tools/webmcp-demo.mjs                    # -> docs/demo.gif
 *   node tools/webmcp-demo.mjs --url <url> --out <path>
 *
 * Needs `npx playwright install chromium` once, and ffmpeg on PATH.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = arg('--url', process.env.WEBMCP_DEMO_URL || 'http://localhost:5173/');
const OUT = path.resolve(arg('--out', path.join(root, 'docs', 'demo.gif')));

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

const frameDir = mkdtempSync(path.join(tmpdir(), 'webmcp-demo-'));
let frame = 0;

// The try-on pipeline needs WebGPU. Headless Chromium has none by default,
// so run its software (SwiftShader) WebGPU — slow but deterministic. Pass
// --headed to use the real GPU instead (a window flashes open).
const headed = args.includes('--headed');
const browser = await chromium.launch({
  headless: !headed,
  args: headed
    ? []
    : ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--enable-features=Vulkan,WebGPU'],
});
const page = await browser.newPage({ viewport: { width: 1160, height: 730 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(120_000);

async function callTool(name, toolArgs = {}) {
  return page.evaluate(
    async ({ name, toolArgs }) => {
      const mc = document.modelContext ?? navigator.modelContext;
      const tool = (await mc.getTools()).find((t) => t.name === name);
      const raw = await mc.executeTool(tool, JSON.stringify(toolArgs));
      const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return env.structuredContent ?? env;
    },
    { name, toolArgs },
  );
}

/** Screenshot into the frame sequence; `hold` repeats it for a longer on-screen beat. */
async function shot(hold = 1) {
  for (let i = 0; i < hold; i++) {
    frame += 1;
    await page.screenshot({ path: path.join(frameDir, `f${String(frame).padStart(3, '0')}.png`) });
  }
}
const pause = (ms) => page.waitForTimeout(ms);

/** Fingerprint a torso-height strip of the composite, to detect when a new garment has drawn. */
const STRIP_PROBE = `(() => {
  const c = document.querySelector('main canvas.debug-canvas');
  if (!c || !c.width) return null;
  const d = c.getContext('2d').getImageData(0, Math.floor(c.height * 0.45), c.width, 2).data;
  let s = 0; for (let i = 0; i < d.length; i += 17) s += d[i];
  return s;
})()`;
const probe = () => page.evaluate(STRIP_PROBE);
const waitForCompositeChange = (before) =>
  page.waitForFunction(`(${STRIP_PROBE}) !== ${before}`, null, { timeout: 30_000 });

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    async () => {
      const mc = document.modelContext ?? navigator.modelContext;
      return mc && (await mc.getTools()).length >= 5;
    },
    null,
    { timeout: 30_000 },
  );

  // Wait for the on-device pipeline to actually initialise — PerfStats (the
  // BACKEND / SEGMENT / POSE tiles) renders only when pipeline.status is
  // 'ready'. Without this the try-on silently no-ops and the GIF just shows
  // the bare photo.
  await page
    .waitForSelector('.perf-stats', { timeout: 150_000 })
    .catch(() => {
      throw new Error(
        'pipeline never became ready — SwiftShader WebGPU may be unavailable. Re-run with --headed.',
      );
    });
  await pause(1500);

  // Tighten the layout so the indicator, canvas, reaction bar and looks tray
  // all sit in one frame; drop the advanced-mode row and the error text.
  await page.addStyleTag({
    content: `
      header h1, .tagline { display: none !important; }
      .error { display: none !important; }
      .top-bar { padding: 6px 0 !important; }
      main { margin: 6px 0 !important; }
      .debug-canvas { max-height: 262px !important; width: auto !important; }
      .controls { margin: 4px 0 !important; row-gap: 5px !important; }
      .looks-panel { margin-top: 6px !important; }
      .look-card { width: 96px !important; }
      .reaction-bar { padding: 6px 8px !important; }
    `,
  });
  // Hide the advanced-mode row and the "your photo / test photos" row —
  // the agent loads the photo, and it keeps the loop in one frame.
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.controls button, .controls input[type=file]')) {
      const t = b.textContent || '';
      if (/Enhance \(3D\)/.test(t) || b.type === 'file') {
        b.closest('.controls')?.style.setProperty('display', 'none', 'important');
      }
    }
  });
  await pause(700);
  await shot(3); // app loaded, "AI stylist tools live — search · try-on · save · compare · reaction"

  // ── the agent styles for a sangeet ───────────────────────────────────────
  await callTool('search_catalog', { occasion: 'sangeet', maxPrice: 8000 });
  await pause(600);
  // First apply: execute awaits the on-device pipeline (segmentation + pose),
  // then selects the garment; the warp composites a beat after it returns.
  const a1 = await callTool('apply_tryon', { garmentId: 'dress-magenta-wrap-01' });
  if (!a1.ok) console.warn('apply_tryon(magenta):', JSON.stringify(a1));
  await page.waitForFunction(`(${STRIP_PROBE}) !== null`);
  await pause(1600);
  await shot(4); // "🎨 Stylist put you in Magenta Wrap Maxi Dress" banner + the dress warping on
  await pause(2600);

  await callTool('await_reaction', { reaction: 'love', note: 'perfect for the sangeet' });
  await pause(400);
  await callTool('save_look', { label: 'Magenta sangeet' });
  await pause(900);
  await shot(4); // reaction bar "❤️ Love it — perfect for the sangeet", first saved look

  // ── the human wants to see a lehenga ─────────────────────────────────────
  const magentaStrip = await probe();
  const a2 = await callTool('apply_tryon', { garmentId: 'lehenga-pink' });
  if (!a2.ok) console.warn('apply_tryon(lehenga):', JSON.stringify(a2));
  await pause(500);
  await shot(2); // "🎨 Stylist put you in Blush Pink Lehenga Choli" banner
  await waitForCompositeChange(magentaStrip); // the lehenga has actually drawn
  await pause(700);
  await shot(3); // the blush-pink lehenga composited

  await callTool('await_reaction', { reaction: 'like' });
  await pause(400);
  await callTool('save_look', { label: 'Blush lehenga' });
  await pause(900);
  await shot(4); // two saved looks in the tray

  // ── compare, then the human decides ─────────────────────────────────────
  await callTool('compare_looks', { lookIds: ['look-1', 'look-2'] });
  await page.waitForSelector('.looks-compare', { timeout: 5000 });
  await pause(1000);
  await shot(6); // side-by-side comparison (held)
} finally {
  await browser.close();
}

// ── stitch to GIF ────────────────────────────────────────────────────────
const ffmpeg = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const vf =
  'fps=10,scale=1000:-1:flags=lanczos,split[s0][s1];' +
  '[s0]palettegen=max_colors=240:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4';
const res = spawnSync(
  ffmpeg,
  ['-y', '-framerate', '1.7', '-i', path.join(frameDir, 'f%03d.png'), '-vf', vf, '-loop', '0', OUT],
  { stdio: 'inherit' },
);
rmSync(frameDir, { recursive: true, force: true });

if (res.status !== 0 || !existsSync(OUT)) {
  console.error('✗ ffmpeg failed');
  process.exit(1);
}
const kb = Math.round((await import('node:fs')).statSync(OUT).size / 1024);
console.log(`\n✓ ${path.relative(root, OUT)} — ${frame} frames, ${kb} KB`);
