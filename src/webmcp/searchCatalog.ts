/**
 * Pure catalog search backing the WebMCP `search_catalog` tool (see
 * useStylistTools.ts). Framework-free and deterministic so it's unit-testable
 * in isolation — the tool wrapper only adapts its shape to the agent.
 *
 * The catalog is tiny (a curated demo set), so this is a linear scan with
 * simple keyword scoring rather than a real index. What matters is that the
 * agent's three levers — free-text `query`, `occasion`, and `maxPrice` — each
 * narrow the results predictably.
 */
import type { Garment } from '../garments/schema';

export interface CatalogSearchParams {
  /** Free text, e.g. "flowy floral dress" or "red lehenga for a wedding". */
  query?: string;
  /** Occasion tag, matched against each garment's `meta.occasion`, e.g. "sangeet". */
  occasion?: string;
  /** Primary colour, e.g. "navy". */
  color?: string;
  /** Garment category, e.g. "dress" / "kurti" / "lehenga-choli" (also accepts "lehenga"). */
  category?: string;
  /** Maximum price in INR (₹) — garments priced above this are excluded. */
  maxPrice?: number;
}

export interface CatalogSearchHit {
  id: string;
  name: string;
  category: string;
  /** INR, or null if the entry carries no price. */
  price: number | null;
  color: string | null;
  occasion: string[];
  sleeves: string;
  length: string;
  /** Relevance score for the given query (0 when no `query` was supplied). */
  score: number;
}

const CATEGORY_ALIASES: Record<string, string> = {
  lehenga: 'lehenga-choli',
  'lehenga-choli': 'lehenga-choli',
  choli: 'lehenga-choli',
  dress: 'dress',
  dresses: 'dress',
  kurti: 'kurti',
  kurta: 'kurti',
  kurtis: 'kurti',
};

/** Tokens in a query that carry no filtering signal — stripped before scoring. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'for', 'me', 'my', 'i', 'to', 'with', 'in', 'on', 'of',
  'something', 'anything', 'show', 'find', 'want', 'need', 'looking', 'under',
  'below', 'less', 'than', 'and', 'or', 'that', 'this', 'some', 'wear', 'outfit',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Every lowercase keyword a garment should match on. */
function garmentKeywords(g: Garment): string[] {
  const kw: string[] = [g.category];
  if (g.category === 'lehenga-choli') kw.push('lehenga', 'choli', 'ethnic');
  if (g.category === 'kurti') kw.push('kurta', 'ethnic', 'indian');
  if (g.category === 'dress') kw.push('western', 'gown');
  kw.push(g.meta.sleeves, `${g.meta.sleeves}-sleeve`, g.meta.length, `${g.meta.length}-length`);
  if (g.meta.color) kw.push(g.meta.color);
  if (g.meta.occasion) kw.push(...g.meta.occasion);
  if (g.meta.name) kw.push(...tokenize(g.meta.name));
  return kw;
}

/** Runs a search over the catalog, returning hits ordered most-relevant first. */
export function searchCatalog(catalog: Garment[], params: CatalogSearchParams): CatalogSearchHit[] {
  const wantCategory = params.category
    ? (CATEGORY_ALIASES[params.category.toLowerCase().trim()] ?? params.category.toLowerCase().trim())
    : null;
  const wantOccasion = params.occasion?.toLowerCase().trim() || null;
  const wantColor = params.color?.toLowerCase().trim() || null;
  const queryTokens = params.query ? tokenize(params.query) : [];

  const hits: CatalogSearchHit[] = [];

  for (const g of catalog) {
    if (wantCategory && g.category !== wantCategory) continue;
    if (
      wantOccasion &&
      !(g.meta.occasion ?? []).some((o) => o === wantOccasion || o.includes(wantOccasion))
    ) {
      continue;
    }
    if (wantColor && g.meta.color !== wantColor) continue;
    if (params.maxPrice !== undefined) {
      // No price ⇒ can't honour a budget ⇒ exclude rather than guess.
      if (g.meta.price === undefined || g.meta.price > params.maxPrice) continue;
    }

    let score = 0;
    if (queryTokens.length > 0) {
      const kw = garmentKeywords(g);
      for (const tok of queryTokens) {
        if (kw.some((k) => k === tok)) score += 2;
        else if (kw.some((k) => k.includes(tok) || tok.includes(k))) score += 1;
      }
      // A query that matched nothing on this garment is not a hit.
      if (score === 0) continue;
    }

    hits.push({
      id: g.id,
      name: g.meta.name ?? g.id,
      category: g.category,
      price: g.meta.price ?? null,
      color: g.meta.color ?? null,
      occasion: g.meta.occasion ?? [],
      sleeves: g.meta.sleeves,
      length: g.meta.length,
      score,
    });
  }

  // Query present ⇒ rank by relevance then price; otherwise cheapest-first so
  // a bare `maxPrice` / `occasion` search leads with the safest budget picks.
  hits.sort((a, b) => b.score - a.score || (a.price ?? Infinity) - (b.price ?? Infinity));
  return hits;
}
