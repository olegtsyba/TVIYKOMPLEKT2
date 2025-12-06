
export interface Review {
  user: string;
  rating: number;
  text: string;
  type?: 'video' | 'image';
  url?: string;
}

export interface SizeChart {
  columns: string[];
  rows: string[][];
}

export interface RelatedColor {
  name: string;
  id: number | string;
  colorCode: string;
}

export interface Product {
  id: number | string; // Changed to support Firestore string IDs
  title: string;
  price: number;
  images: string[];
  sizes: string[];
  colors: string[];
  videoId?: string;
  sizeCategory?: string; // Links to global SIZE_CHARTS
  sizeChart?: SizeChart; // Specific override
  reviews?: Review[];
  relatedColors?: RelatedColor[];
  image?: string; // Legacy support
}

export interface CartItem extends Product {
  selectedSize: string;
  cartId: number;
}
