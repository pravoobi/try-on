/**
 * Downloads the .tflite models into public/models/ (gitignored).
 * Usage: npm run fetch-models [-- --force]
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODELS = [
  {
    // square (256×256) general model — better person resolution on portrait photos
    file: 'selfie_segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  },
  {
    // landscape (256×144) model — for the live-webcam phase
    file: 'selfie_segmenter_landscape.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite',
  },
  {
    file: 'movenet_singlepose_lightning.tflite',
    // Redirects to a signed Kaggle URL. GET only — the endpoint 404s on HEAD.
    url: 'https://tfhub.dev/google/lite-model/movenet/singlepose/lightning/tflite/float16/4?lite-format=tflite',
  },
];

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');
const force = process.argv.includes('--force');

await mkdir(outDir, { recursive: true });

for (const { file, url } of MODELS) {
  const dest = path.join(outDir, file);
  if (!force && (await exists(dest))) {
    console.log(`skip ${file} (exists; use --force to re-download)`);
    continue;
  }
  process.stdout.write(`fetching ${file} ... `);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`FAILED: ${res.status} ${res.statusText} for ${url}`);
    process.exitCode = 1;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`${(buf.length / 1024).toFixed(0)} KB`);
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
