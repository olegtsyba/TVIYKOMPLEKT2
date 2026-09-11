import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import {
  AvailabilityStatus,
  BadgeType,
  MarketingBadge,
  Product,
  ProductAvailability,
  ProductSettings,
} from '../types';

// Per-product editorial settings the admin owns, keyed by KeyCRM product id.
// Deliberately one collection for all the small scalar flags rather than one
// per feature - the storefront already does a full read of four collections at
// startup and each extra one costs another round trip.

export const BADGE_LABELS: Record<BadgeType, string> = {
  new: 'NEW',
  hit: 'ХІТ',
  limited: 'LIMITED',
  back: 'ПОВЕРНУЛОСЬ',
};

// in_stock has no label: it is the default and shows nothing.
export const AVAILABILITY_LABELS: Record<Exclude<AvailabilityStatus, 'in_stock'>, string> = {
  out_of_stock: 'НЕМАЄ В НАЯВНОСТІ',
  expected: 'ОЧІКУЄТЬСЯ',
  preorder: 'ПЕРЕДЗАМОВЛЕННЯ',
};

const BADGE_TYPES = Object.keys(BADGE_LABELS) as BadgeType[];
const AVAILABILITY_STATUSES: AvailabilityStatus[] = ['in_stock', 'out_of_stock', 'expected', 'preorder'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEAD_TIME_MAX = 40;

// Local calendar date, so "до 2026-09-30" stops at the shopper's own midnight
// rather than at some UTC boundary.
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isBadgeVisible(badge?: MarketingBadge): boolean {
  if (!badge) return false;
  if (!badge.until) return true;
  return today() <= badge.until;
}

// The storefront shows at most one editorial label, and availability outranks
// marketing: "НЕМАЄ В НАЯВНОСТІ" matters more to a shopper than "ХІТ".
export function resolveCardLabel(product: Product): string | null {
  const status = product.availability?.status;
  if (status && status !== 'in_stock') return AVAILABILITY_LABELS[status];
  if (product.marketingBadge) return BADGE_LABELS[product.marketingBadge.type];
  return null;
}

export function isPreorder(product: Product): boolean {
  return product.availability?.status === 'preorder';
}

// Only plain in-stock goes through the cart. Preorder included: it is agreed in
// the chat with a manager, since orders must land in KeyCRM rather than Telegram.
export function isPurchasable(product: Product): boolean {
  const status = product.availability?.status;
  return !status || status === 'in_stock';
}

function parseDate(value: unknown): string | undefined {
  return typeof value === 'string' && DATE_RE.test(value) ? value : undefined;
}

function parseAvailability(raw: any): ProductAvailability | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  if (!AVAILABILITY_STATUSES.includes(raw.status)) return undefined;

  const status = raw.status as AvailabilityStatus;
  if (status === 'in_stock') return undefined; // default; nothing to carry

  const date = status === 'expected' ? parseDate(raw.date) : undefined;
  const leadTimeRaw = status === 'preorder' && typeof raw.leadTime === 'string' ? raw.leadTime.trim() : '';
  const leadTime = leadTimeRaw ? leadTimeRaw.slice(0, LEAD_TIME_MAX) : undefined;

  return { status, ...(date ? { date } : {}), ...(leadTime ? { leadTime } : {}) };
}

// Reads the current { badge: { type, until } } shape and the earlier
// { newBadge: { enabled, until } } one, which only ever meant NEW. Saving from
// the admin rewrites a document into the new shape and drops the old field, so
// this fallback exists purely so nothing disappears in between.
function parseBadge(raw: any): MarketingBadge | undefined {
  const badgeRaw = raw?.badge;
  if (badgeRaw && typeof badgeRaw === 'object' && BADGE_TYPES.includes(badgeRaw.type)) {
    const until = parseDate(badgeRaw.until);
    return { type: badgeRaw.type as BadgeType, ...(until ? { until } : {}) };
  }

  const legacy = raw?.newBadge;
  if (legacy && typeof legacy === 'object' && legacy.enabled === true) {
    const until = parseDate(legacy.until);
    return { type: 'new', ...(until ? { until } : {}) };
  }

  return undefined;
}

export async function fetchProductSettingsMap(): Promise<Map<string, ProductSettings>> {
  const map = new Map<string, ProductSettings>();
  try {
    const snap = await getDocs(collection(db, 'productSettings'));
    snap.docs.forEach(docSnap => {
      const raw = docSnap.data();
      const badge = parseBadge(raw);
      const availability = parseAvailability(raw.availability);
      if (!badge && !availability) return;
      map.set(docSnap.id, { ...(badge ? { badge } : {}), ...(availability ? { availability } : {}) });
    });
  } catch (err) {
    console.warn('Could not fetch productSettings, continuing without it', err);
  }
  return map;
}

export function applyProductSettings(product: Product, settings?: ProductSettings): Product {
  if (!settings) return product;

  const badge = isBadgeVisible(settings.badge) ? settings.badge : undefined;
  const availability = settings.availability;
  if (!badge && !availability) return product;

  return {
    ...product,
    ...(badge ? { marketingBadge: badge } : {}),
    ...(availability ? { availability } : {}),
  };
}
