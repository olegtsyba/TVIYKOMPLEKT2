
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
  badgeText?: string; // Custom promo badge (e.g. "-20%", "Чорна п'ятниця")
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

export interface Promotion {
  productId: number | string; // KeyCRM product id
  oldPrice?: number;
  discountPercent?: number;
  badgeText?: string;
  activeFrom?: string; // ISO date
  activeTo?: string; // ISO date
  isActive: boolean;
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