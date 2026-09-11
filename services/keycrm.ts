import { Product, ProductVariantOffer } from '../types';
import { SIZE_ORDER, COLOR_ALIASES } from '../constants';

const PROXY_BASE = '/api/keycrm';
const PAGE_LIMIT = 50;

const SIZE_PROPERTY_HINTS = ['розмір', 'размер', 'size'];
const COLOR_PROPERTY_HINTS = ['колір', 'цвет', 'color', 'колер'];

export interface KeycrmProduct {
  id: number;
  name: string;
  description: string | null;
  thumbnail_url: string | null;
  attachments_data: string[] | null;
  quantity: number;
  min_price: number;
  max_price: number;
  has_offers: boolean;
  is_archived: boolean;
  category_id: number | null;
  created_at: string;
}

export interface KeycrmOfferProperty {
  name: string;
  value: string;
}

export interface KeycrmOffer {
  id: number;
  product_id: number;
  sku: string;
  thumbnail_url: string | null;
  price: number;
  quantity: number;
  properties: KeycrmOfferProperty[];
  is_archived: boolean;
}

interface KeycrmPage<T> {
  data: T[];
  current_page: number;
  last_page: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Our proxy (functions/index.js keycrmProxy) only forwards KeyCRM's status
// code + body, not response headers, so there's no Retry-After to read -
// just back off with increasing delays. 4 attempts total (3 retries).
const RATE_LIMIT_BACKOFF_MS = [1000, 2000, 4000];

async function fetchJson<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => search.set(key, String(value)));
  const qs = search.toString();
  const url = `${PROXY_BASE}${path}${qs ? `?${qs}` : ''}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();

    if (res.status === 429 && attempt < RATE_LIMIT_BACKOFF_MS.length) {
      await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
      continue;
    }
    throw new Error(`KeyCRM proxy request failed: ${path} (${res.status})`);
  }
}

export async function fetchAllKeycrmProducts(): Promise<KeycrmProduct[]> {
  const all: KeycrmProduct[] = [];
  let page = 1;
  let lastPage = 1;
  do {
    const data = await fetchJson<KeycrmPage<KeycrmProduct>>('/products', { limit: PAGE_LIMIT, page });
    all.push(...data.data);
    lastPage = data.last_page;
    page += 1;
  } while (page <= lastPage);
  return all.filter(p => !p.is_archived);
}

export async function fetchOffersForProduct(productId: number | string): Promise<KeycrmOffer[]> {
  const all: KeycrmOffer[] = [];
  let page = 1;
  let lastPage = 1;
  do {
    const data = await fetchJson<KeycrmPage<KeycrmOffer>>('/offers', {
      'filter[product_id]': productId,
      limit: PAGE_LIMIT,
      page,
    });
    all.push(...data.data);
    lastPage = data.last_page;
    page += 1;
  } while (page <= lastPage);
  return all.filter(o => !o.is_archived);
}

// Same /offers endpoint, no product_id filter -> every offer in the shop
// (paginated, ~39 pages catalog-wide vs 3 for /products). Used to populate
// sizes/colors for the whole catalog up front (color filter needs every
// product's colors, not just ones the user has opened) instead of one
// request per product. onPage lets the caller merge results incrementally
// as pages arrive rather than waiting for all ~39.
//
// PAGE_DELAY_MS throttles requests between pages - firing all ~39 back to
// back tripped KeyCRM's rate limit (429, observed live 2026-09-11). fetchJson
// also retries individual 429s with backoff, but spacing requests out here
// avoids triggering the limit in the first place.
const OFFERS_PAGE_DELAY_MS = 200;

export async function fetchAllKeycrmOffers(onPage?: (pageOffers: KeycrmOffer[]) => void): Promise<KeycrmOffer[]> {
  const all: KeycrmOffer[] = [];
  let page = 1;
  let lastPage = 1;
  do {
    const data = await fetchJson<KeycrmPage<KeycrmOffer>>('/offers', { limit: PAGE_LIMIT, page });
    const active = data.data.filter(o => !o.is_archived);
    all.push(...active);
    onPage?.(active);
    lastPage = data.last_page;
    page += 1;
    if (page <= lastPage) await sleep(OFFERS_PAGE_DELAY_MS);
  } while (page <= lastPage);
  return all;
}

// Session-scoped cache for the derived (sizes/colors/variantOffers) result of
// fetchAllKeycrmOffers, keyed by product id. Storing the derived shape rather
// than raw offers keeps it tiny (a few KB) and avoids re-running
// deriveVariants on every catalog visit. sessionStorage (not localStorage) -
// cleared per tab/session by design, so a schema change never needs manual
// cache-busting for returning visitors.
const OFFERS_VARIANTS_CACHE_KEY = 'tvk_offers_variants_cache_v1';

export function readCachedOfferVariants(): Record<string, ProductVariants> | null {
  try {
    const raw = sessionStorage.getItem(OFFERS_VARIANTS_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeCachedOfferVariants(map: Record<string, ProductVariants>): void {
  try {
    sessionStorage.setItem(OFFERS_VARIANTS_CACHE_KEY, JSON.stringify(map));
  } catch {
    // sessionStorage unavailable (private mode / quota) - filter just won't be cached, non-fatal.
  }
}

// KeyCRM product descriptions are free text written for internal use. They
// often end with a supplier / wholesale block (price lists, dropship links,
// Google Sheets) that must never reach the storefront. sanitizeDescription
// cuts that block and any stray URLs, keeps the human-facing copy and emoji,
// and tidies whitespace. Returns '' when nothing usable is left — the UI then
// falls back to DEFAULT_PRODUCT_DESCRIPTION.
const SUPPLIER_BLOCK_MARKER = /^[ \t]*(Наявність|ОПТ|Опт|Наличие)\s*:/im;
// Also eat any inline spaces before the link so removing it mid-sentence
// doesn't leave a double space.
const BARE_URL = /[ \t]*\bhttps?:\/\/\S+/gi;
const BARE_WWW = /[ \t]*\bwww\.\S+/gi;

export function sanitizeDescription(raw: string | null | undefined): string {
  if (!raw) return '';
  let text = raw;

  // 1. Drop the supplier/wholesale block and everything after its marker.
  const marker = text.match(SUPPLIER_BLOCK_MARKER);
  if (marker && marker.index !== undefined) {
    text = text.slice(0, marker.index);
  }

  // 2. Strip any links left elsewhere in the copy.
  text = text.replace(BARE_URL, '').replace(BARE_WWW, '');

  // 3. Tidy whitespace: trailing spaces per line, runs of blank lines, ends.
  text = text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

export function mapKeycrmProduct(kc: KeycrmProduct): Product {
  const images = kc.attachments_data && kc.attachments_data.length > 0
    ? kc.attachments_data
    : (kc.thumbnail_url ? [kc.thumbnail_url] : []);

  return {
    id: kc.id,
    title: kc.name,
    price: kc.min_price,
    categoryId: kc.category_id,
    description: sanitizeDescription(kc.description) || undefined,
    images,
    sizes: [],
    colors: [],
    relatedColors: [],
  };
}

function matchesHint(name: string, hints: string[]): boolean {
  const normalized = name.trim().toLowerCase();
  return hints.some(hint => normalized.includes(hint));
}

export function getMinOfferPrice(offers: KeycrmOffer[]): number | null {
  const prices = offers.map(o => o.price).filter(p => typeof p === 'number' && p > 0);
  if (prices.length === 0) return null;
  return Math.min(...prices);
}

// Every KeyCRM product with offers also carries one placeholder offer whose
// only property is Колір="Всі кольори" (or a case/typo variant) and no size
// — verified catalog-wide (1870 offers, Sept 2026): it always coexists with
// real per-color/size offers, never appears alone, and its price is NOT a
// reliable signal (sometimes 0, sometimes a real price). Must be excluded
// from variant derivation entirely, by value + absence of a size property.
const CATCHALL_COLOR_VALUES = new Set(['всі кольори', 'всі кольри']);

function isCatchAllOffer(offer: KeycrmOffer): boolean {
  const props = offer.properties || [];
  const hasSize = props.some(p => matchesHint(p.name, SIZE_PROPERTY_HINTS));
  if (hasSize) return false;
  const colorProp = props.find(p => matchesHint(p.name, COLOR_PROPERTY_HINTS));
  if (!colorProp) return false;
  return CATCHALL_COLOR_VALUES.has(colorProp.value.trim().toLowerCase());
}

// A handful of KeyCRM sizes are typed with Cyrillic look-alike letters
// (е.g. Cyrillic "М" instead of Latin "M") that read identically but don't
// deduplicate as strings. Map the confusable ones to Latin before comparing.
const CYRILLIC_TO_LATIN: Record<string, string> = {
  'А': 'A', 'а': 'a', 'В': 'B', 'в': 'b', 'Е': 'E', 'е': 'e',
  'К': 'K', 'к': 'k', 'М': 'M', 'м': 'm', 'Н': 'H', 'н': 'h',
  'О': 'O', 'о': 'o', 'Р': 'P', 'р': 'p', 'С': 'C', 'с': 'c',
  'Т': 'T', 'т': 't', 'Х': 'X', 'х': 'x',
};

function normalizeSizeLabel(raw: string): string {
  return raw
    .split('')
    .map(ch => CYRILLIC_TO_LATIN[ch] ?? ch)
    .join('')
    .trim()
    .toUpperCase();
}

// '-' and similar non-alphabetic entries are garbage data (KeyCRM sizes are
// always word-like: "S", "M", "L-XL", ...) — drop them rather than showing a
// meaningless size button.
function isJunkSizeLabel(label: string): boolean {
  return !/[A-Z]/.test(label);
}

// Sorts by the rank of the label's first component in SIZE_ORDER, so a range
// like "L-XL" sorts next to "L". Unrecognized labels sort after all known
// ones, alphabetically among themselves.
export function sizeSortKey(label: string): number {
  const firstToken = label.split(/[^A-Z]+/).find(Boolean) ?? label;
  const idx = SIZE_ORDER.indexOf(firstToken);
  return idx === -1 ? Number.POSITIVE_INFINITY : idx;
}

// Folds casing + the known typo/plural/bilingual variants (COLOR_ALIASES)
// into one canonical name. '-' (real garbage in the catalog) maps to ''.
function normalizeColorLabel(raw: string): string {
  const key = raw.trim().toLowerCase();
  return COLOR_ALIASES[key] ?? key;
}

export interface ProductVariants {
  sizes: string[];
  colors: string[];
  variantOffers: ProductVariantOffer[];
}

export function deriveVariants(offers: KeycrmOffer[]): ProductVariants {
  const sizesSet = new Set<string>();
  const colorsSet = new Set<string>();
  const variantOffers: ProductVariantOffer[] = [];

  offers.forEach(offer => {
    if (isCatchAllOffer(offer)) return;

    let color: string | null = null;
    let size: string | null = null;
    (offer.properties || []).forEach(prop => {
      if (matchesHint(prop.name, SIZE_PROPERTY_HINTS)) {
        const normalized = normalizeSizeLabel(prop.value);
        if (!isJunkSizeLabel(normalized)) {
          size = normalized;
          sizesSet.add(normalized);
        }
      } else if (matchesHint(prop.name, COLOR_PROPERTY_HINTS)) {
        const normalized = normalizeColorLabel(prop.value);
        if (normalized) {
          color = normalized;
          colorsSet.add(normalized);
        }
      }
    });

    variantOffers.push({
      offerId: offer.id,
      color,
      size,
      price: offer.price,
      quantity: offer.quantity,
      thumbnailUrl: offer.thumbnail_url ?? null,
    });
  });

  const sizes = Array.from(sizesSet).sort((a, b) => {
    const rank = sizeSortKey(a) - sizeSortKey(b);
    return rank !== 0 ? rank : a.localeCompare(b);
  });

  return { sizes, colors: Array.from(colorsSet), variantOffers };
}

// Groups a flat offers list (e.g. from fetchAllKeycrmOffers) by product_id
// and runs deriveVariants per group - used to populate sizes/colors for the
// whole catalog at once instead of one deriveVariants call per product.
export function deriveVariantsByProduct(offers: KeycrmOffer[]): Record<string, ProductVariants> {
  const byProduct = new Map<number, KeycrmOffer[]>();
  offers.forEach(offer => {
    const list = byProduct.get(offer.product_id);
    if (list) list.push(offer);
    else byProduct.set(offer.product_id, [offer]);
  });
  const result: Record<string, ProductVariants> = {};
  byProduct.forEach((productOffers, productId) => {
    result[String(productId)] = deriveVariants(productOffers);
  });
  return result;
}
