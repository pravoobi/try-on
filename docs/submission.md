# Virtual Try-On + AI Stylist

## Inspiration

Virtual try-on is almost always a server job. You upload your photo, a diffusion
model runs somewhere, you pay per inference, and the shopper has to be okay with
a picture of themselves sitting on someone's GPUs. We'd built the other version
of this: a try-on that runs in the browser on WebGPU, so the preview is instant,
costs nothing to serve, and the photo never leaves the laptop.

Then agents started doing people's shopping. The catch is that an agent is bad at
the one thing fashion actually needs, which is knowing whether something looks
good on you. WebMCP let us split the work along that line. The agent does the
mechanical part (find things, put them on, save, compare) and the person keeps
the judgement call.

WebMCP is the right fit here because the tools already existed — they're the
buttons on the page. There's no API to stand up and no server to run, the agent
drives the same UI a person does, and what it can and can't do is exactly what
the page allows. A styling loop needs the human in it on every turn, and WebMCP
puts the agent and the person in the same room instead of the agent working a
copy of the site somewhere else.

## What it does

You open the app with a photo or your webcam and it draws garments onto you,
on-device. Person segmentation, 17-point pose estimation, and a thin-plate-spline
warp of the garment onto your body, all in a Web Worker, no server call anywhere.

The page also registers five WebMCP tools on `document.modelContext`:

| Tool | |
|---|---|
| `search_catalog` | filter by occasion, colour, category, budget (₹) |
| `apply_tryon` | run the pipeline and composite a garment onto the photo |
| `save_look` | snapshot the result into a tray |
| `compare_looks` | show saved looks side by side |
| `await_reaction` | get the verdict: love it, good, try another, not this |

A WebMCP client picks these up automatically — ChatGPT's built-in browser, a
Chrome agent, or Claude through a bridge extension.

Styling an outfit online is usually a chore. You set filters on a product grid,
open five or six product pages one at a time, and try to picture each one on
yourself across separate tabs. Here you say "a sangeet outfit under ₹8k" and the
agent runs `search_catalog({ occasion: "sangeet", maxPrice: 8000 })`, gets back
the one match, and `apply_tryon`s it onto your photo — one turn. You say "love
it" and it `save_look`s. You say "show me a lehenga too" and it applies a second
one and `compare_looks` puts them side by side. The agent handles the searching,
the fitting and the bookkeeping; you only ever react.

Each tool is a small wrapper around code the page already ran. There's no new
business logic behind them, no scraping the DOM, and nothing a tool can do that
spends money or commits to anything.

## How we built it

### WebMCP

The five tools live in one adapter file, `src/webmcp/useStylistTools.ts`. Each is
a `useWebMCP` hook that registers on `document.modelContext` with a JSON-schema
input and a handler that forwards to something the page already had — the
garment-select function behind the picker, an in-memory looks tray, the reaction
bar. There is no logic in the tools that isn't also reachable by clicking.

- `search_catalog` is a keyword-scored filter over the catalog with its own unit
  tests (occasion, colour, category, budget).
- `apply_tryon` cold-loads a default model photo if none is picked, so the loop
  works from a blank slate, then runs the on-device pipeline.
- `save_look` snapshots the composited `<canvas>` into the tray.
- `compare_looks` opens the side-by-side view and reports any unknown look ids
  rather than failing.
- `await_reaction` is **dual-mode**: the agent passes the reaction it heard in
  chat (`{ reaction: "love" }`) and gets guidance back immediately, or it omits
  the argument and the call blocks until the user taps a reaction chip. Either
  way the app's reaction bar shows what the human said. We added this after
  watching ChatGPT read "love it" off the transcript and never call the tool.

`@mcp-b/global` installs `document.modelContext` where the browser doesn't ship
it and steps aside for the native one where it does, so the same code runs under
Chrome's native WebMCP, ChatGPT's browser, and a bridge to Claude. A Playwright
smoke test calls every tool through `getTools()` / `executeTool()` and checks the
responses — 19 assertions.

The annotations carry hints too: `search_catalog` is `readOnlyHint`, the writes
are `idempotentHint`, and `apply_tryon`'s response tells the agent to call
`await_reaction` next. Agents are cautious about site tools, and that hint chain
noticeably steadied the flow.

### The pipeline underneath

LiteRT.js on WebGPU with a Wasm/XNNPACK fallback, running MediaPipe Selfie
Segmenter and MoveNet SinglePose Lightning, plus a thin-plate-spline solver we
wrote by hand. The warp $f$ minimises the bending energy

$$\iint_{\mathbb{R}^2}\left(f_{xx}^2 + 2f_{xy}^2 + f_{yy}^2\right)\,dx\,dy$$

subject to $f(\mathbf{p}_i) = \mathbf{q}_i$ at the anchor pairs. That has a closed
form,

$$f(\mathbf{x}) = \mathbf{c} + \mathbf{A}\mathbf{x} + \sum_i w_i\,\varphi\!\left(\lVert \mathbf{x} - \mathbf{p}_i \rVert\right), \qquad \varphi(r) = r^2 \log r,$$

which we sample on a coarse triangle mesh and draw with per-triangle affine
texturing, since canvas 2D has no real nonlinear warp. It's published as
`@practics/tryon-core`; the app is a thin React shell over it.

### The human-agent layer

When the agent applies a garment (not you tapping a thumbnail), the preview
flashes a border and a banner: "Stylist put you in ...". The four reaction chips
feed `await_reaction`, which returns `{ reaction, note, guidance }` so the agent
knows whether to save, swap, or start over. The catalog is eight garments across
dresses, kurtis and lehengas, each tagged with price, occasion and colour so
`search_catalog` has something real to filter on.

## Challenges we ran into

WebMCP is very new. The spec renamed `navigator.modelContext` to
`document.modelContext` while we were working, and browser support is only just
arriving. We had to check that the polyfill really does hand off to the native
implementation, which it does: a non-configurable `document.modelContext` means
the browser owns it and our `registerTool` calls land on the real thing.

For a while the agent kept doing a web search instead of calling our tools. Part
of it was that we hadn't redeployed, so the live site genuinely had no tools. The
rest was ChatGPT being cautious. It wants an explicit "use sitetools:" and a
model that supports WebMCP. A one-liner in the console settled it:
`Object.getOwnPropertyDescriptor(document, 'modelContext').configurable` came
back `false` and `getTools()` returned all five, so the tools had reached
ChatGPT's runtime and the problem was upstream of us.

`await_reaction` didn't fire in chat at first. It waited for a chip tap, but in a
conversation you just type "love it" and the agent reads that off the transcript.
We made it work both ways: pass the reaction you already heard, or leave it out
and block for a tap. Either path updates the reaction bar so the app and the
agent stay in sync.

The deploy failed twice. `npm ci` choked on a transitive Wasm-shim package that
pins different patch versions on the Linux CI runner than on our machine, and the
runner's older npm wouldn't accept the newer lockfile at all. We fixed it by
matching the CI Node version and letting `npm install` reconcile the lock.

Recording the demo headless turned out to be a dead end. Headless Chromium has no
WebGPU, so the pipeline quietly does nothing while `apply_tryon` still reports
success and the canvas just shows the plain photo. The recorders run headed on a
real GPU and watch a strip of canvas pixels to confirm a garment has actually
drawn before taking each shot.

## Accomplishments that we're proud of

The loop runs in a real agent against the deployed site, not a stubbed demo.

Five tools, a reaction channel that works from chat or from a tap, a full
end-to-end test, and repeatable scripts for the GIF and thumbnail, with no server
and no new business logic anywhere.

The human-agent flow is intentional. You can always see what the agent did, your
reaction goes back as structured data rather than a guess, and you make the final
call.

And it sits on top of a try-on app that already existed and does real work,
rather than a shell built for the weekend.

## What we learned

WebMCP shifts the question from "what can the agent do" to "what should stay with
the person". Fit and taste are theirs, and the tools are built around not
touching that.

Tool wording matters more than we expected. Agents are careful about calling site
tools, so the hint that `apply_tryon` drops about calling `await_reaction` next
actually changes the flow, and the agent started reusing our chip labels ("Love
it, Good, or try another?") in its own replies.

A tool that blocks is the wrong shape for a chat agent that already has the
answer. Letting the human respond however they want, chip or sentence, worked
better than picking one.

One code path, the `@mcp-b/global` polyfill, covered Chrome's native API,
ChatGPT's browser, and Claude over a bridge.

## What's next for Virtual Try-On + AI Stylist

A paid HD tier, exposed as a `render_hd` tool that calls a server-side
IDM-VTON-class model for a print-quality render, offered by the agent only after
you've settled on a look.

A real checkout handoff. We left it impossible on purpose for now; the plan is a
`checkout` tool that only runs after an explicit confirmation from you, never
from the agent alone.

A bigger catalog. The pipeline already handles pants, shirts and multi-piece
outfits; the demo is limited to the eight garments we tuned anchors for.

Sarees, which are draped rather than worn and need pre-rendered drape templates
warped as one piece.

Folding the tool layer into `@practics/tryon-core` so any store widget built on
the pipeline gets the agent surface for free.
