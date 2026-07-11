/**
 * Downloads free-license full-body test photos (Wikimedia Commons) into
 * public/test-photos/ (gitignored). The app's quick-load buttons serve them
 * from there. Usage: npm run fetch-test-photos [-- --force]
 *
 * Licenses: CC BY 2.0 requires attribution — keep this manifest with the
 * files; do not ship these images in a commercial build.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PHOTOS = [
  {
    file: 'photo-01.jpg',
    note: 'swimwear, frontal, hands on hip — "Leggy model on the runway" by Kevin Trotman, CC BY 2.0',
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Leggy_model_on_the_runway_at_the_fashion_show_%28IMG_0124a%29_%283508948725%29.jpg/960px-Leggy_model_on_the_runway_at_the_fashion_show_%28IMG_0124a%29_%283508948725%29.jpg',
  },
  {
    file: 'photo-02.jpg',
    note: 'top + shorts, 3/4 stance — "Model ready to hit the runway (IMG 7651a)", CC BY 2.0',
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ce/Model_ready_to_hit_the_runway_%28IMG_7651a%29_%285459400817%29.jpg/960px-Model_ready_to_hit_the_runway_%28IMG_7651a%29_%285459400817%29.jpg',
  },
  {
    file: 'photo-03.jpg',
    note: 'loose dress, arm on hip — "Stephanie ready to hit the runway (IMG 7666a)", CC BY 2.0',
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Stephanie_ready_to_hit_the_runway_%28IMG_7666a%29_%285459417671%29.jpg/960px-Stephanie_ready_to_hit_the_runway_%28IMG_7666a%29_%285459417671%29.jpg',
  },
  {
    file: 'photo-04.jpg',
    note: 'grayscale robustness case — "Unidentified young woman modeling fashion, Fort Lauderdale", public domain (Florida Memory)',
    url: 'https://upload.wikimedia.org/wikipedia/commons/f/f9/Unidentified_young_woman_modeling_fashion-_Fort_Lauderdale%2C_Florida_%286714161397%29.jpg',
  },
  {
    file: 'photo-05.jpg',
    note: 'green kurti, cluttered indoor scene with background people (single-person stress test) — "In my salwar suit" by Melanie M, CC BY 2.0',
    url: 'https://upload.wikimedia.org/wikipedia/commons/2/21/In_my_salwar_suit.jpg',
  },
];

const outDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'test-photos',
);
const force = process.argv.includes('--force');
const USER_AGENT = 'try-on-dev/0.1 (https://github.com/pravoobi/try-on; test photo fetch script)';
const MAX_ATTEMPTS = 4;

await mkdir(outDir, { recursive: true });

for (const { file, url, note } of PHOTOS) {
  const dest = path.join(outDir, file);
  if (!force && (await exists(dest))) {
    console.log(`skip ${file} (exists)`);
    continue;
  }
  process.stdout.write(`fetching ${file} (${note.split('—')[0].trim()}) ... `);
  try {
    const buf = await fetchWithRetry(url);
    await writeFile(dest, buf);
    console.log('ok');
  } catch (err) {
    console.error(`FAILED: ${err.message} for ${url}`);
    process.exitCode = 1;
  }
}

/** Wikimedia rate-limits (429) fairly aggressively on shared CI IPs — retry with backoff. */
async function fetchWithRetry(url) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status !== 429 || attempt === MAX_ATTEMPTS) {
      throw new Error(String(res.status));
    }
    const retryAfterSec = Number(res.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : 2 ** attempt * 1000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('unreachable');
}

await writeFile(
  path.join(outDir, 'ATTRIBUTION.md'),
  ['# Test photo attribution (Wikimedia Commons)', '', ...PHOTOS.map((p) => `- ${p.file}: ${p.note}\n  ${p.url}`)].join('\n') + '\n',
);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
