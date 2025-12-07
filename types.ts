
export interface Review {
  user: string;
  rating: number;
  text: string;
  type?: 'video' | 'image';
  url?: string;
}

export interface SizeChartRow {
  size: string;
  bust: string;
  waist: string;
  hips: string;
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
  id: number | string;
  title: string;
  price: number;
  oldPrice?: number;
  isNew?: boolean; // New field for "NEW" status
  images: string[];
  sizes: string[];
  colors: string[];
  videoId?: string;
  sizeCategory?: string;
  sizeChart?: SizeChartRow[]; 
  reviews?: Review[];
  relatedColors?: RelatedColor[];
  image?: string; // Legacy support
}

export interface CartItem extends Product {
  selectedSize: string;
  cartId: number;
}

export interface SiteSettings {
  heroTitle: string;
  heroSubtitle: string;
  heroBackgroundUrl: string;
  heroDescription: string;
  logoText: string;
}