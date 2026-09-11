import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { Product, ProductSettings } from '../types';

// Per-product editorial settings the admin owns, keyed by KeyCRM product id.
// Deliberately one collection for all the small scalar flags rather than one
// per feature - the storefront already does a full read of four collections at
// startup and each extra one costs another round trip.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Local calendar date, so "NEW до 2026-09-30" stops being new when the shopper's
// own date rolls past it rather than at some UTC boundary.
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isNewBadgeVisible(settings?: ProductSettings): boolean {
  const badge = settings?.newBadge;
  if (!badge || badge.enabled !== true) return false;
  if (!badge.until) return true;
  return today() <= badge.until;
}

function parseSettings(raw: any): ProductSettings | null {
  const badgeRaw = raw?.newBadge;
  if (!badgeRaw || typeof badgeRaw !== 'object') return null;

  const enabled = badgeRaw.enabled === true;
  const until = typeof badgeRaw.until === 'string' && DATE_RE.test(badgeRaw.until)
    ? badgeRaw.until
    : undefined;

  if (!enabled) return null;
  return { newBadge: { enabled, ...(until ? { until } : {}) } };
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
  const isNew = isNewBadgeVisible(settings);
  if (!isNew) return product;
  return { ...product, isNew: true };
}
