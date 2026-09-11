import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { Product, PhotoModelInfo } from '../types';

// Twin of normalizePhotoUrl in admin.html (product modal, model-info section).
// Entries are keyed by photo URL rather than gallery index because KeyCRM
// reorders attachments; if these two implementations ever diverge, every
// lookup silently misses and no plaque renders.
export const normalizePhotoUrl = (url: string): string => String(url || '').split(',')[0].trim();

// Mirrors MODEL_INFO_RANGES in admin.html. The admin rejects out-of-range input,
// but older rows predate that check, so the storefront re-validates rather than
// trusting the document.
const RANGES = {
  height: { min: 100, max: 250 },
  bust: { min: 60, max: 150 },
  waist: { min: 40, max: 130 },
  hips: { min: 60, max: 160 },
} as const;

const NOTE_MAX = 150;

function validMeasurement(value: unknown, key: keyof typeof RANGES): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  const { min, max } = RANGES[key];
  return value >= min && value <= max ? value : undefined;
}

// Height and size are what the plaque's summary line is made of, so an entry
// missing either is dropped entirely. A bad optional measurement drops just
// that field and the rest of the entry still renders.
function parseEntry(raw: any): { url: string; info: PhotoModelInfo } | null {
  const url = normalizePhotoUrl(raw?.url);
  const height = validMeasurement(raw?.height, 'height');
  const size = typeof raw?.size === 'string' ? raw.size.trim() : '';
  if (!url || height === undefined || !size) return null;

  const info: PhotoModelInfo = { height, size };

  const bust = validMeasurement(raw?.bust, 'bust');
  const waist = validMeasurement(raw?.waist, 'waist');
  const hips = validMeasurement(raw?.hips, 'hips');
  if (bust !== undefined) info.bust = bust;
  if (waist !== undefined) info.waist = waist;
  if (hips !== undefined) info.hips = hips;

  const note = typeof raw?.note === 'string' ? raw.note.trim().slice(0, NOTE_MAX) : '';
  if (note) info.note = note;

  return { url, info };
}

export async function fetchProductModelInfoMap(): Promise<Map<string, Record<string, PhotoModelInfo>>> {
  const map = new Map<string, Record<string, PhotoModelInfo>>();
  try {
    const snap = await getDocs(collection(db, 'productModelInfo'));
    snap.docs.forEach(docSnap => {
      const data = docSnap.data();
      const photos = Array.isArray(data.photos) ? data.photos : [];
      const byUrl: Record<string, PhotoModelInfo> = {};
      photos.forEach((raw: any) => {
        const parsed = parseEntry(raw);
        if (parsed) byUrl[parsed.url] = parsed.info;
      });
      if (Object.keys(byUrl).length === 0) return;
      map.set(docSnap.id, byUrl);
    });
  } catch (err) {
    console.warn('Could not fetch productModelInfo, continuing without it', err);
  }
  return map;
}

export function applyProductModelInfo(product: Product, modelInfoByUrl?: Record<string, PhotoModelInfo>): Product {
  if (!modelInfoByUrl) return product;
  return { ...product, modelInfoByUrl };
}
