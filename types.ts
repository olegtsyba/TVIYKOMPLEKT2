
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

// One real KeyCRM offer (a specific color/size combination), normalized for
// the storefront. Produced by services/keycrm.ts#deriveVariants — the
// catch-all "Всі кольори" placeholder offer every KeyCRM product carries is
// already filtered out, so any entry here is a genuine purchasable variant.
export interface ProductVariantOffer {
  offerId: number;
  color: string | null; // canonical color name (see constants.ts COLOR_ALIASES), null if this product has no color property
  size: string | null;  // normalized size label, null if this product has no size property
  price: number;
  quantity: number; // KeyCRM stock count; NOT used to decide in-stock (see deriveVariants) — kept for future use
  thumbnailUrl: string | null;
}

export interface Product {
  id: number | string;
  title: string;
  price: number;
  categoryId?: number | null; // KeyCRM category_id, used for catalog filter buttons
  description?: string; // sanitized KeyCRM description (see services/keycrm.ts)
  oldPrice?: number;
  isNew?: boolean; // New field for "NEW" status
  badgeText?: string; // Custom promo badge (e.g. "-20%", "Чорна п'ятниця")
  images: string[];
  sizes: string[];
  colors: string[];
  variantOffers?: ProductVariantOffer[]; // real KeyCRM offers, for per-color/size stock + photo lookup
  videoId?: string;
  sizeCategory?: string;
  sizeChart?: SizeChartRow[];
  reviews?: Review[];
  relatedColors?: RelatedColor[];
  image?: string; // Legacy support
  extraVideos?: string[]; // Admin-uploaded video reviews (productMedia/{keycrmId}.videos)
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
  selectedColor?: string;
  cartId: number;
}

export interface SiteSettings {
  heroTitle: string;
  heroSubtitle: string;
  heroBackgroundUrl: string;
  heroDescription: string;
  logoText: string;
}