import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { Product, Review } from '../types';

export async function fetchProductReviewsMap(): Promise<Map<string, Review[]>> {
  const map = new Map<string, Review[]>();
  try {
    const snap = await getDocs(collection(db, 'productReviews'));
    snap.docs.forEach(docSnap => {
      const data = docSnap.data();
      const reviews = Array.isArray(data.reviews) ? data.reviews : [];
      if (reviews.length === 0) return;
      map.set(docSnap.id, reviews.map((r: any) => ({
        user: r.user,
        rating: r.rating,
        text: r.text,
        date: r.date,
        type: r.type || undefined,
        url: r.url || undefined,
      })));
    });
  } catch (err) {
    console.warn('Could not fetch productReviews, continuing without it', err);
  }
  return map;
}

export function applyProductReviews(product: Product, reviews?: Review[]): Product {
  if (!reviews || reviews.length === 0) return product;
  return { ...product, reviews };
}
