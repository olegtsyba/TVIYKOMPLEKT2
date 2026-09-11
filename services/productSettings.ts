import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { BadgeType, MarketingBadge, Product, ProductSettings } from '../types';

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

const BADGE_TYPES = Object.keys(BADGE_LABELS) as BadgeType[];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

// Reads the current { badge: { type, until } } shape and the earlier
// { newBadge: { enabled, until } } one, which only ever meant NEW. Saving from
// the admin rewrites a document into the new shape and drops the old field, so
// this fallback exists purely so nothing disappears in between.
function parseSettings(raw: any): ProductSettings | null {
  const until = (value: unknown): string | undefined =>
    typeof value === 'string' && DATE_RE.test(value) ? value : undefined;

  const badgeRaw = raw?.badge;
  if (badgeRaw && typeof badgeRaw === 'object' && BADGE_TYPES.includes(badgeRaw.type)) {
    const u = until(badgeRaw.until);
    return { badge: { type: badgeRaw.type as BadgeType, ...(u ? { until: u } : {}) } };
  }

  const legacy = raw?.newBadge;
  if (legacy && typeof legacy === 'object' && legacy.enabled === true) {
    const u = until(legacy.until);
    return { badge: { type: 'new', ...(u ? { until: u } : {}) } };
  }

  return null;
}

export async function fetchProductSettingsMap(): Promise<Map<string, ProductSettings>> {
  const map = new Map<string, ProductSettings>();
  try {
    const snap = await getDocs(collection(db, 'productSettings'));
    snap.docs.forEach(docSnap => {
      const parsed = parseSettings(docSnap.data());
      if (parsed) map.set(docSnap.id, parsed);
    });
  } catch (err) {
    console.warn('Could not fetch productSettings, continuing without it', err);
  }
  return map;
}

export function applyProductSettings(product: Product, settings?: ProductSettings): Product {
  const badge = settings?.badge;
  if (!isBadgeVisible(badge)) return product;
  return { ...product, marketingBadge: badge };
}
