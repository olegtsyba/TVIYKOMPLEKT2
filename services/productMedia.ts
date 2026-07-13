import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { Product } from '../types';

interface ProductMediaEntry {
  photoUrls: string[];
  videoUrls: string[];
}

export async function fetchProductMediaMap(): Promise<Map<string, ProductMediaEntry>> {
  const map = new Map<string, ProductMediaEntry>();
  try {
    const snap = await getDocs(collection(db, 'productMedia'));
    snap.docs.forEach(docSnap => {
      const data = docSnap.data();
      const photoUrls = Array.isArray(data.photos) ? data.photos.map((p: any) => p.url).filter(Boolean) : [];
      const videoUrls = Array.isArray(data.videos) ? data.videos.map((v: any) => v.url).filter(Boolean) : [];
      if (photoUrls.length === 0 && videoUrls.length === 0) return;
      map.set(docSnap.id, { photoUrls, videoUrls });
    });
  } catch (err) {
    console.warn('Could not fetch productMedia, continuing without it', err);
  }
  return map;
}

export function applyProductMedia(product: Product, media?: ProductMediaEntry): Product {
  if (!media) return product;

  const images = media.photoUrls.length > 0 ? [...product.images, ...media.photoUrls] : product.images;
  const extraVideos = media.videoUrls.length > 0 ? media.videoUrls : undefined;

  if (images === product.images && !extraVideos) return product;
  return { ...product, images, ...(extraVideos ? { extraVideos } : {}) };
}
