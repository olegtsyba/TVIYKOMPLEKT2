import { Product } from '../types';

const PROXY_BASE = '/api/keycrm';
const PAGE_LIMIT = 50;
const NEW_WINDOW_DAYS = 14;

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

async function fetchJson<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => search.set(key, String(value)));
  const qs = search.toString();
  const res = await fetch(`${PROXY_BASE}${path}${qs ? `?${qs}` : ''}`);
  if (!res.ok) {
    throw new Error(`KeyCRM proxy request failed: ${path} (${res.status})`);
  }
  return res.json();
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

function isWithinDays(dateStr: string, days: number): boolean {
  const created = new Date(dateStr).getTime();
  if (Number.isNaN(created)) return false;
  return Date.now() - created <= days * 24 * 60 * 60 * 1000;
}

export function mapKeycrmProduct(kc: KeycrmProduct): Product {
  const images = kc.attachments_data && kc.attachments_data.length > 0
    ? kc.attachments_data
    : (kc.thumbnail_url ? [kc.thumbnail_url] : []);

  return {
    id: kc.id,
    title: kc.name,
    price: kc.min_price,
    images,
    sizes: [],
    colors: [],
    isNew: isWithinDays(kc.created_at, NEW_WINDOW_DAYS),
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

export function deriveVariants(offers: KeycrmOffer[]): { sizes: string[]; colors: string[] } {
  const sizes = new Set<string>();
  const colors = new Set<string>();
  offers.forEach(offer => {
    (offer.properties || []).forEach(prop => {
      if (matchesHint(prop.name, SIZE_PROPERTY_HINTS)) sizes.add(prop.value);
      else if (matchesHint(prop.name, COLOR_PROPERTY_HINTS)) colors.add(prop.value);
    });
  });
  return { sizes: Array.from(sizes), colors: Array.from(colors) };
}
