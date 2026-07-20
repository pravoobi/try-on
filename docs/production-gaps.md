# Production gaps — road to a merchant-facing product

Assessment date: 2026-07-18. Context: the pipeline is production-quality as
an **engagement feature** ("see it on you"), not a fit-accuracy feature —
2D TPS warping of flat product photos cannot show drape/fit and should
never be framed as if it does. A Shopify app is in progress; independent
(non-Shopify) stores are the likely second market, which raises the
priority of the embeddable widget below.

## Rendering quality (ordered by return on effort)

1. ~~**Sleeve-aware warping**~~ — DONE 2026-07-18: optional elbow/cuff
   anchors + synthesized sleeve-cap pin (tryon-core `anchorCorrespondences`).
   **Full-sleeve anchors are declined for a BENT arm** (`sleeve.minStraightness`,
   cos of the elbow angle): a flat photo's straight sleeve can't fold around
   a hand-on-hip elbow, and forcing the TPS to try bends the whole garment —
   shipped briefly as the kurti's bust pinching inward with a sleeve tearing
   off as a floating strip. Declining falls back to torso-only anchoring,
   i.e. exactly the pre-feature rendering. Half sleeves are unaffected (they
   end mid-upper-arm, so the forearm never enters into it).
   Residual to tune: a small shoulder gap can remain on the side whose arm
   hangs tightest against the body (largest rotation from the photo pose) —
   knobs are `SLEEVE_CAP_PIN_T` and per-garment elbow anchor placement.
   Sleeve anchors exist on the generated tees/shirt and the kurti; the
   upload flow and annotate tool can't place them yet.
2. ~~**Real product photography**~~ — DONE 2026-07-18: 17 real garments
   ingested (8 trousers, 3 shorts, 2 shirts, 1 tee, 4 kurtis), the 6
   procedural placeholders deleted. Catalog is now 21 real garments.

   **Rebuilt again 2026-07-20** from flat/ghost-mannequin photography —
   38 garments now (14 pants, 9 lehenga-choli, 6 kurti, 3 shirt, 3 tshirt,
   3 dress).

   **Which tool to use — this is the fork that matters:**
   - `tools/build-flat-garments.mjs` — flat-lay, hanger, or ghost-mannequin
     shots with NO person. Keys the background; no models needed.
   - `tools/extract-worn-garments.mjs` — ON-MODEL shots. Runs MODNet +
     SegFormer to strip the wearer, and needs a target ('upper'/'lower')
     because a worn photo always contains both halves of an outfit.
   - `tools/process-new-garments.mjs` — the original flood-fill keyer,
     superseded by build-flat-garments for anything catalog-bound.

   Review every batch with `tools/garment-contact-sheet.mjs`, which
   composites cutouts over magenta with anchor dots: a cutout reviewed on
   white or a light checkerboard hides precisely the failures worth finding.

   **Keying a flat photo: colour vs ML.** The flood-fill keyer decides by
   colour distance from the backdrop, so it cannot separate a WHITE garment
   from a WHITE sweep — a white kurti came out in fragments, white denim
   shorts took a gash, pale cholis vanished. Those garments set
   `keyer: 'ml'` in the manifest to matte with MODNet instead (learned
   salient foreground, not colour). Rule of thumb: light garment on a light
   background → `ml`; everything else → the fast colour path.

   **Detached garment parts are normal.** A lehenga-choli photographed flat
   has the choli floating clear above the skirt. Speck-pruning must drop
   only components that are insignificant next to the largest (2% here),
   never "keep exactly one" — that silently deletes the choli and looks
   like a keying failure.

   **Flat photography is markedly easier to ingest than on-model.** The
   on-model batch lost 9 of 26 to hair and hands being subtracted as
   separate classes; the flat batch lost 1 of 35, and that one only because
   the frame also contained the model's jeans (two garments in one photo
   needs semantic parsing, not keying). Prefer flat/ghost-mannequin sources.

   **Photo requirements for ON-MODEL sources** — learned when 9 of 26 were
   unusable:
   - **Arms away from the garment.** Hands on hips or in pockets get
     labelled `Left-arm`/`Right-arm` and subtracted, biting notches out of
     the silhouette. Interior holes are auto-filled now, but damage that
     touches the image border can't be (it isn't enclosed), which is what
     wrecked `shorts-black-high-rise`, `shirt-striped-casual` and
     `tshirt-polo-collared`.
   - **Hair off the shoulders.** Long hair falling over a shoulder is
     labelled `Hair` and removed the same way.
   - **Whole garment in frame**, hem included (`lehnga-choli-yellow` was
     cropped at the skirt hem, so there was no hem to anchor).
   - **No dupatta / draped scarf** on lehengas — 2D TPS cannot warp drape
     (same reason sarees are deferred); it smears when warped.
   - Straight-on beats angled; plain background beats a styled set.
3. ~~**Photo-mode matting**~~ — DONE 2026-07-18: the matting worker gained a
   'person' mode (matte only, no garment extraction), and photo mode swaps
   the low-res segmenter mask for the MODNet matte once it lands
   (progressive; rides the advanced-mode opt-in; photo downscaled to
   config.photoMatting.maxDim before matting). Hair-strand-level edges
   confirmed. Live mode still uses the segmenter (MODNet too slow per
   frame).
4. ~~**Color harmonization**~~ — DONE 2026-07-18: tryon-core harmonize.ts
   nudges each garment layer's exposure + color cast toward the
   illumination measured on the person region (clamped, strength-blended;
   GPU apply via brightness-filter + multiply + alpha-restore, live-mode
   cheap). "match colors" checkbox is the A/B. When advanced shading runs,
   only the cast applies (shading already does scene-driven exposure).
   Tuning knobs in config.harmonize if the nudge needs to be stronger.
5. **Pose/segmentation model upgrades** — MoveNet Thunder or BlazePose (33
   kps) for steadier anchors; photo-mode first (fps cost).
6. **Advanced-mode passes on GPU** — shading/depth-occlusion are CPU canvas
   loops (~3fps at 720p live); porting to WebGPU shaders makes them
   live-viable.
7. ~~Server-side diffusion tier~~ — dropped from the plan (2026-07-18):
   hosted photorealistic try-on is a crowded, GPU-capital-heavy race
   (funded startups + Google in Search/Shopping). If merchants demand HD
   renders, resell a partner API as a pro add-on — never own the infra.

## Self-serve garment pipeline (merchant onboarding path)

Goal: a free merchant gets a decent result in ~15 minutes via the upload
flow (`GarmentUpload.tsx`) alone — matting → auto-anchor → drag-correct →
save, no engineering help needed.

- ~~**Sleeve/pants annotation UI**~~ — DONE 2026-07-18: uploads now support
  `pants` (new `suggestPantsAnchors` in tryon-core: waistband = widest row
  in the top band, hems = each leg's outer bottom corner) alongside the
  existing top-like categories, and top-like uploads get optional
  elbow/cuff sleeve anchors (auto-placed off the shoulder anchors,
  drag-correctable) when `sleeves` is full/half. `AnchorEditor` is now
  generic over an arbitrary named-anchor set instead of hardcoded to the
  6-point top shape. Lehenga-choli and back-photo sleeve anchors are still
  out of scope (uploads don't produce lehenga-cholis at all; a back photo's
  sleeve anchors aren't annotated). `tools/annotate.html` (the standalone,
  no-build-step tool) is unaware of both sleeve and pants anchors — only
  the in-app flow has them.
- ~~**Render-while-you-drag preview**~~ — DONE 2026-07-18: `TryOnPreview.tsx`
  composites the draft garment live onto whatever photo is loaded in
  photo-mode, re-rendering as anchors move — this is the safety net for a
  bad auto-suggestion, and it's been visually confirmed to update
  correctly on drag. **Uses `setTimeout(fn, 0)` for the coalescing, not
  `requestAnimationFrame`** — rAF is throttled/paused while a tab is
  backgrounded per spec, which would silently freeze the preview if the
  dialog loses tab focus mid-drag (discovered via this exact failure mode
  in automated testing: the effect ran, but its rAF callback never fired
  for image loaded from a non-visible tab).
- **MODNet flat-lay matting quality (new gotcha, found 2026-07-18):** the
  matting worker's model (`Xenova/modnet`) is a *portrait/person* matting
  model, not a general product-photography one. On a real on-model photo
  it should be in-distribution and reliable (matches its training data).
  On a flat-lay pants photo tested this session it badly under-alpha'd the
  waistband — confidence rose gradually and peaked near the ankle instead
  of the hip, an inversion no geometric anchor heuristic can correct for,
  since the input alpha itself misrepresents the garment. (The specific
  test image was also procedurally flat-shaded with none of a real photo's
  texture/lighting noise, which may itself confuse a matting model trained
  on photographs — re-test with a REAL flat-lay photo before concluding
  this is a hard blocker rather than a test-fixture artifact.) Until
  re-verified: recommend on-model photos over flat-lay for pants uploads,
  and treat the drag-correct UI as load-bearing for pants specifically, not
  just a nice-to-have.

## Business model (decided 2026-07-18)

Freemium widget SaaS. **Free: unlimited on-device try-on** — zero marginal
cost per try-on is the structural pricing advantage metered per-render
competitors can't match; the "powered by" badge is the acquisition loop.
**Pro (flat per-store monthly): analytics** (conversion attribution — the
ROI proof), **customization/white-label**, and **done-for-you catalog
onboarding** (doubles as churn killer and switching cost; plain priority
support rides along). Open-core split: pipeline/packages public (MIT), the
hosted widget service + Shopify app private.

## Product/engineering gaps

- **Embeddable widget** — script-tag/iframe wrapper over the npm packages;
  THE deliverable for independent (non-Shopify) stores. Needs: camera
  permission UX, model-asset CDN strategy, theming, a minimal JS API
  (`mount(el, {catalogUrl})`). The hosted half (embed delivery, merchant
  config, analytics collection, billing) lives in a PRIVATE repo.
- **Mobile Safari / iOS support** — promoted from "testing gap" to LAUNCH
  BLOCKER: most shoppers are on phones; WebGPU availability is the risk,
  and the wasm fallback must be verified actually usable on mid-range
  iPhones/Androids. No mobile-device test pass has been done yet.
- **Catalog ingestion at scale** — flood-fill bg removal + hand-checked
  anchors won't survive hundreds of SKUs; needs an automated pipeline with
  a human QA step. (Sleeve/pants auto-suggestion now exists — see above —
  but scaling to hundreds of SKUs unattended is still unproven.)
- **Conversion analytics** — try-on engagement → add-to-cart lift is the
  sales pitch; needs event hooks in the widget (privacy-preserving,
  on-device stance intact).
- **Sizing** — no size recommendation exists; separate problem (fit tech).
  Do not imply fit in merchant-facing copy until this exists.
- **Lehenga-choli uploads** — the upload flow only ever produces top-like
  or pants garments; a two-piece lehenga-choli ensemble can't be uploaded
  (would need its own two-photo flow, mirroring the catalog's manual
  authoring today).
- **tools/annotate.html** — the standalone, no-build-step annotation tool
  is unaware of sleeve or pants anchors; only the in-app upload flow has
  them. Low priority unless that tool becomes part of a batch pipeline.
