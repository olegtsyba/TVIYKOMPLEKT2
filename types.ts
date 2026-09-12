
export interface Review {
  user: string;
  rating: number;
  text: string;
  date?: string; // YYYY-MM-DD, admin-entered (often retroactive - review predates entry)
  type?: 'video' | 'image';
  url?: string;
  storagePath?: string; // Storage path for the attached file, used by admin.html to delete it
}

// Measurements of the model shown in one specific gallery photo, so a shopper
// can judge fit. Optional fields are absent rather than null when unset — the
// product card renders a row only for the fields that are present.
export interface PhotoModelInfo {
  height: number; // cm
  size: string;   // XS..XXL
  bust?: number;  // cm
  waist?: number; // cm
  hips?: number;  // cm
  note?: string;
}

export type BadgeType = 'new' | 'hit' | 'limited' | 'back';

export interface MarketingBadge {
  type: BadgeType;
  until?: string; // YYYY-MM-DD; absent means "until switched off"
}

// Availability is editorial, not stock-driven: KeyCRM's `quantity` is unusable
// here (most live offers sit at <= 0 while selling), so a manager sets it.
// Manual products in step 6 reuse this same vocabulary per variant.
export type AvailabilityStatus = 'in_stock' | 'out_of_stock' | 'expected' | 'preorder';

export interface ProductAvailability {
  status: AvailabilityStatus;
  date?: string;     // YYYY-MM-DD, 'expected' only - when it lands
  leadTime?: string; // free text, 'preorder' only - e.g. "7-10 днів"
}

// Editorial flags the admin sets per product (productSettings/{keycrmId}).
// The badge is entirely manual - there is no automatic "recently added" rule
// any more, because upload date turned out to be a poor proxy for what the
// shop actually wants to promote.
export interface ProductSettings {
  badge?: MarketingBadge;
  availability?: ProductAvailability;
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
  sku: string; // KeyCRM article - the only way an order line links back to the catalog
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
  marketingBadge?: MarketingBadge;     // set from productSettings (see services/productSettings.ts)
  availability?: ProductAvailability;  // absent means in stock
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
  modelInfoByUrl?: Record<string, PhotoModelInfo>; // keyed by normalized photo URL
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
  // Resolved when the item is added, not at checkout: the offer list can be
  // refreshed in the background afterwards. Absent for manual products, for
  // carts saved before this existed, and when no offer matches.
  selectedSku?: string;
  cartId: number;
}

export interface SiteSettings {
  heroTitle: string;
  heroSubtitle: string;
  heroBackgroundUrl: string;
  heroDescription: string;
  logoText: string;
}