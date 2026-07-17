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
   Residual to tune: a small shoulder gap can remain on the side whose arm
   hangs tightest against the body (largest rotation from the photo pose) —
   knobs are `SLEEVE_CAP_PIN_T` and per-garment elbow anchor placement.
   Sleeve anchors exist on the generated tees/shirt and the kurti; the
   upload flow and annotate tool can't place them yet.
2. **Real product photography** for the shirt/tshirt/pants catalog entries —
   the procedural PNGs prove the pipeline but would undermine a merchant
   demo. Drop raws in `tools/raw-garments/`, run
   `tools/process-new-garments.mjs`, hand-check anchors (esp. puff sleeves).
3. ~~**Photo-mode matting**~~ — DONE 2026-07-18: the matting worker gained a
   'person' mode (matte only, no garment extraction), and photo mode swaps
   the low-res segmenter mask for the MODNet matte once it lands
   (progressive; rides the advanced-mode opt-in; photo downscaled to
   config.photoMatting.maxDim before matting). Hair-strand-level edges
   confirmed. Live mode still uses the segmenter (MODNet too slow per
   frame).
4. **Color harmonization** — match garment layer exposure/white balance to
   the scene before compositing; cheap and large realism gain.
5. **Pose/segmentation model upgrades** — MoveNet Thunder or BlazePose (33
   kps) for steadier anchors; photo-mode first (fps cost).
6. **Advanced-mode passes on GPU** — shading/depth-occlusion are CPU canvas
   loops (~3fps at 720p live); porting to WebGPU shaders makes them
   live-viable.
7. **Server-side diffusion tier** (IDM-VTON-class or commercial API) — the
   photorealistic premium render; live mode stays the free instant preview.

## Product/engineering gaps

- **Embeddable widget** — script-tag/iframe wrapper over the npm packages;
  THE deliverable for independent (non-Shopify) stores. Needs: camera
  permission UX, model-asset CDN strategy, theming, a minimal JS API
  (`mount(el, {catalogUrl})`).
- **Catalog ingestion at scale** — flood-fill bg removal + hand-checked
  anchors won't survive hundreds of SKUs; needs an automated pipeline with
  a human QA step (and sleeve-anchor auto-suggestion; upload flow still
  can't annotate sleeves or pants).
- **iOS/Safari coverage** — WebGPU availability is the risk; wasm fallback
  needs real mid-range-phone testing. No mobile-device test pass has been
  done.
- **Conversion analytics** — try-on engagement → add-to-cart lift is the
  sales pitch; needs event hooks in the widget (privacy-preserving,
  on-device stance intact).
- **Sizing** — no size recommendation exists; separate problem (fit tech).
  Do not imply fit in merchant-facing copy until this exists.
- **Lehenga-choli sleeve anchors + pants uploads** — choli pieces don't get
  sleeve targets yet; the upload flow is top-like only.
- **tools/annotate.html** — not yet aware of sleeve or pants anchors.
