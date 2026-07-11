import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { Product, Promotion } from '../types';

export async function fetchActivePromotions(): Promise<Map<string, Promotion>> {
  const map = new Map<string, Promotion>();
  try {
    const q = query(collection(db, 'promotions'), where('isActive', '==', true));
    const snap = await getDocs(q);
    const now = Date.now();
    snap.docs.forEach(docSnap => {
      const data = docSnap.data() as Promotion;
      if (data.activeFrom && new Date(data.activeFrom).getTime() > now) return;
      if (data.activeTo && new Date(data.activeTo).getTime() < now) return;
      map.set(String(data.productId ?? docSnap.id), data);
    });
  } catch (err) {
    console.warn('Could not fetch promotions, continuing without them', err);
  }
  return map;
}

export function applyPromotion(product: Product, promo?: Promotion): Product {
  if (!promo) return product;

  let oldPrice = promo.oldPrice;
  if (!oldPrice && promo.discountPercent) {
    oldPrice = Math.round(product.price / (1 - promo.discountPercent / 100));
  }
  if (!oldPrice || oldPrice <= product.price) return product;

  return { ...product, oldPrice, badgeText: promo.badgeText || undefined };
}
