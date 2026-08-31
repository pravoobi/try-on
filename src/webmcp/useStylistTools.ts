/**
 * Registers the WebMCP "stylist" tool surface (see webmcp-challenge-plan.md).
 *
 * These tools are thin adapters over logic the page already has: the garment
 * catalog, the garment-select handler, and the test-photo loader. An agent
 * (Chrome's built-in, ChatGPT's in-app browser, anything speaking WebMCP)
 * discovers them via `document.modelContext` and drives an
 * agent-searches / human-judges styling loop.
 *
 * `@mcp-b/global` (imported once in main.tsx) installs `document.modelContext`
 * where the browser doesn't ship it natively, and passes through to the
 * native implementation where it does.
 *
 * Tool surface: `search_catalog`, `apply_tryon`, `save_look`, `compare_looks`,
 * `await_reaction`.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useWebMCP } from '@mcp-b/react-webmcp';
import type { Garment } from '../garments/schema';
import type { SavedLook } from '../hooks/useLooks';
import type { Reaction } from '../hooks/useReaction';
import { searchCatalog } from './searchCatalog';

/** Result of an attempted `save_look` — App decides whether the snapshot can be taken. */
export type SaveLookResult = { ok: true; look: SavedLook } | { ok: false; error: string };

interface StylistToolsDeps {
  /** The shipped catalog (not user uploads — the agent only reasons over curated stock). */
  catalog: Garment[];
  /** Currently-worn garment in each outfit slot, for reporting state back to the agent. */
  selectedTop: Garment | null;
  selectedBottom: Garment | null;
  /** Whether a photo is loaded — `apply_tryon` loads a default one if not. */
  hasPhoto: boolean;
  /** Apply a garment to the current photo (App wraps `selectGarment`). */
  onApply: (garment: Garment) => void;
  /** Load the default test photo (used when `apply_tryon` runs with no photo). Resolves once the pipeline has run. */
  onLoadDefaultPhoto: () => Promise<void>;
  /** The saved-looks tray (see hooks/useLooks.ts). */
  looks: SavedLook[];
  /** Snapshot the current try-on into the tray. Fails if nothing is rendered / worn. */
  onSaveLook: (label?: string) => SaveLookResult;
  /** Select saved looks for the side-by-side comparison view. */
  onCompareLooks: (lookIds: string[]) => void;
  /** Block until the human taps a reaction chip (or timeout). See hooks/useReaction.ts. */
  onAwaitReaction: (timeoutMs: number) => Promise<Reaction | null>;
  /** Log a reaction the user already gave in chat, so the app's reaction bar reflects it. */
  onRecordReaction: (kind: Reaction['kind'], note?: string) => void;
}

const SEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Free text, e.g. "flowy floral dress" or "red lehenga for a wedding".',
    },
    occasion: {
      type: 'string',
      description: 'Occasion to dress for, e.g. "sangeet", "wedding", "reception", "brunch", "office".',
    },
    color: { type: 'string', description: 'Preferred colour, e.g. "navy", "magenta", "pink".' },
    category: {
      type: 'string',
      enum: ['dress', 'kurti', 'lehenga-choli'],
      description: 'Restrict to one garment type.',
    },
    maxPrice: { type: 'number', description: 'Budget ceiling in Indian rupees (₹).' },
  },
} as const;

const APPLY_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    garmentId: {
      type: 'string',
      description: 'The `id` of a garment from `search_catalog` (e.g. "dress-magenta-wrap-01").',
    },
  },
  required: ['garmentId'],
} as const;

const SAVE_LOOK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description: 'Short human label for this look, e.g. "the magenta wrap dress". Optional.',
    },
  },
} as const;

const COMPARE_LOOKS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    lookIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Saved look ids from `save_look`, e.g. ["look-1", "look-2"]. Two or three works best.',
    },
  },
  required: ['lookIds'],
} as const;

const AWAIT_REACTION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    reaction: {
      type: 'string',
      enum: ['love', 'like', 'try_another', 'reject'],
      description:
        "If the user ALREADY told you how they feel (in chat), pass it here — this logs it to " +
        'the app and returns next-step guidance immediately, no waiting.',
    },
    note: {
      type: 'string',
      description: 'What the user wants changed, in their words (e.g. "too long", "more colour"). Optional.',
    },
    timeoutSeconds: {
      type: 'number',
      description:
        'Only used when `reaction` is omitted: how long to wait for the user to tap a reaction ' +
        'chip in the app before giving up (default 120, max 600).',
    },
  },
} as const;

const REACTION_GUIDANCE: Record<Reaction['kind'], string> = {
  love: 'They love it. Call save_look, and you are essentially done unless they want options.',
  like: 'Positive but not final. save_look, then you may offer one more option to compare.',
  try_another: 'Apply a different garment — use the next search result, or re-search with their note.',
  reject: 'Not this one. Switch to a clearly different colour/style, or run search_catalog again.',
};

function describeGarment(g: Garment) {
  return {
    id: g.id,
    name: g.meta.name ?? g.id,
    category: g.category,
    price: g.meta.price ?? null,
    color: g.meta.color ?? null,
    occasion: g.meta.occasion ?? [],
  };
}

export function useStylistTools(deps: StylistToolsDeps) {
  // The tool `execute` callbacks live for the lifetime of the registration;
  // keep them reading the latest props through a ref rather than re-registering
  // the tool on every render.
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  const available =
    typeof document !== 'undefined' && !!(document.modelContext ?? navigator.modelContext);

  /** Resolve a garment id against the catalog for tool responses. */
  const describeGarmentId = useCallback((id: string) => {
    const g = depsRef.current.catalog.find((x) => x.id === id);
    return g ? { id, name: g.meta.name ?? id, category: g.category } : { id, name: id };
  }, []);

  const search = useWebMCP({
    name: 'search_catalog',
    description:
      'Search the virtual try-on catalog (dresses, kurtis, lehengas) by free-text query, ' +
      'occasion, colour, category, and/or maximum price in ₹. Returns matching garments with ' +
      'their id, name, price and occasions. Pass a returned id to `apply_tryon` to see it on the user.',
    inputSchema: SEARCH_INPUT_SCHEMA,
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async (input) => {
      const { catalog } = depsRef.current;
      const results = searchCatalog(catalog, input);
      return {
        query: input,
        count: results.length,
        results,
        ...(results.length === 0
          ? { hint: 'Nothing matched. Try loosening the filters — the catalog has only a handful of items.' }
          : {}),
      };
    },
  });

  const apply = useWebMCP({
    name: 'apply_tryon',
    description:
      'Composite a catalog garment onto the loaded photo with the on-device try-on pipeline ' +
      '(segmentation + pose + warp, all in-browser). Pass a garmentId from `search_catalog`. ' +
      'If no photo is loaded, a default model photo is loaded first. After applying, ask the ' +
      'user how it looks before moving on — only they can judge fit and vibe.',
    inputSchema: APPLY_INPUT_SCHEMA,
    annotations: { readOnlyHint: false, idempotentHint: true },
    execute: async ({ garmentId }) => {
      const { catalog, hasPhoto, onApply, onLoadDefaultPhoto } = depsRef.current;
      const garment = catalog.find((g) => g.id === garmentId);
      if (!garment) {
        return {
          ok: false,
          error: `No garment with id "${garmentId}".`,
          availableIds: catalog.map((g) => g.id),
        };
      }

      let loadedDefaultPhoto = false;
      if (!hasPhoto) {
        await onLoadDefaultPhoto();
        loadedDefaultPhoto = true;
      }
      onApply(garment);

      return {
        ok: true,
        applied: describeGarment(garment),
        loadedDefaultPhoto,
        note:
          'The try-on is rendering in the app preview now. Ask the user how it looks, then call ' +
          "await_reaction — pass their reaction if they tell you in chat, or leave it blank to " +
          'wait for a chip tap.',
      };
    },
  });

  const saveLook = useWebMCP({
    name: 'save_look',
    description:
      'Snapshot the current try-on — the composited photo plus which garments are on — into ' +
      "the saved-looks tray so it can be compared later. Optionally pass a short `label`. Call " +
      'this after the user reacts positively to a try-on. Returns the new look id.',
    inputSchema: SAVE_LOOK_INPUT_SCHEMA,
    annotations: { readOnlyHint: false },
    execute: async ({ label }) => {
      const res = depsRef.current.onSaveLook(label);
      if (!res.ok) return { ok: false, error: res.error };
      const l = res.look;
      return {
        ok: true,
        look: {
          id: l.id,
          label: l.label,
          garments: l.garmentIds.map(describeGarmentId),
        },
        // Pre-save list + the new id, so the agent always has the full set.
        allLookIds: [...depsRef.current.looks.map((x) => x.id), l.id],
        note: 'Saved. Apply another garment and save_look again, then compare_looks with the ids.',
      };
    },
  });

  const compareLooks = useWebMCP({
    name: 'compare_looks',
    description:
      'Show saved looks side by side in the app so the user can pick between them. Pass an ' +
      'array of look ids from `save_look`. Returns the looks being compared; then ask the user ' +
      'which they prefer.',
    inputSchema: COMPARE_LOOKS_INPUT_SCHEMA,
    annotations: { readOnlyHint: false, idempotentHint: true },
    execute: async ({ lookIds }) => {
      const all = depsRef.current.looks;
      const known = lookIds.filter((id) => all.some((l) => l.id === id));
      const missing = lookIds.filter((id) => !all.some((l) => l.id === id));
      if (known.length === 0) {
        return {
          ok: false,
          error: 'None of those look ids are saved.',
          availableLookIds: all.map((l) => l.id),
        };
      }
      depsRef.current.onCompareLooks(known);
      const byId = new Map(all.map((l) => [l.id, l]));
      return {
        ok: true,
        comparing: known.map((id) => {
          const l = byId.get(id)!;
          return { id: l.id, label: l.label, garments: l.garmentIds.map(describeGarmentId) };
        }),
        ...(missing.length > 0 ? { missing } : {}),
        note:
          known.length < 2
            ? 'Only one valid look — save or pass another id to get a real side-by-side.'
            : 'Rendered side by side in the app. Ask the user which they prefer.',
      };
    },
  });

  const awaitReaction = useWebMCP({
    name: 'await_reaction',
    description:
      "Record or wait for the user's reaction to the current try-on — call it right after " +
      'apply_tryon. Two ways: (a) if the user already told you how they feel in chat, pass ' +
      '`reaction` (love / like / try_another / reject) and optionally `note` — it logs to the ' +
      "app's reaction bar and returns guidance immediately; (b) omit `reaction` to block until " +
      'the user taps a reaction chip in the app (or it times out). Returns { reaction, note, guidance }.',
    inputSchema: AWAIT_REACTION_INPUT_SCHEMA,
    annotations: { readOnlyHint: false, idempotentHint: true },
    execute: async ({ reaction, note, timeoutSeconds }) => {
      // (a) chat channel — the user already reacted, just log it + guide.
      if (reaction) {
        depsRef.current.onRecordReaction(reaction, note);
        return {
          reaction,
          note: note ?? null,
          source: 'chat',
          guidance: REACTION_GUIDANCE[reaction],
        };
      }
      // (b) chip channel — block for a tap in the app.
      const seconds = Math.min(600, Math.max(5, timeoutSeconds ?? 120));
      const tapped = await depsRef.current.onAwaitReaction(seconds * 1000);
      if (!tapped) {
        return {
          reaction: 'none',
          note: null,
          source: 'timeout',
          guidance: 'The user did not tap a reaction. Ask them in chat, then call this again with their answer.',
        };
      }
      return {
        reaction: tapped.kind,
        note: tapped.note,
        source: 'chip',
        guidance: REACTION_GUIDANCE[tapped.kind],
      };
    },
  });

  const describeWorn = useCallback(() => {
    const { selectedTop, selectedBottom } = depsRef.current;
    return [selectedTop, selectedBottom].filter((g): g is Garment => !!g).map(describeGarment);
  }, []);

  return {
    /** True when a WebMCP runtime is present (native or polyfilled). */
    available,
    searchState: search.state,
    applyState: apply.state,
    saveLookState: saveLook.state,
    compareLooksState: compareLooks.state,
    awaitReactionState: awaitReaction.state,
    /** Currently-worn garments, for a UI activity readout. */
    describeWorn,
  };
}
