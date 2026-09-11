import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { PRODUCTS, CATEGORIES, SIZE_CHARTS, DEFAULT_PRODUCT_DESCRIPTION, COLOR_HEX } from './constants';
import { Product, CartItem, SiteSettings, Review, SizeChartRow } from './types';
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import {
  fetchAllKeycrmProducts, fetchOffersForProduct, mapKeycrmProduct, deriveVariants,
  fetchAllKeycrmOffers, deriveVariantsByProduct, readCachedOfferVariants, writeCachedOfferVariants, sizeSortKey,
  type KeycrmOffer, type ProductVariants,
} from './services/keycrm';
import { fetchActivePromotions, applyPromotion } from './services/promotions';
import { fetchProductMediaMap, applyProductMedia } from './services/productMedia';
import { fetchProductReviewsMap, applyProductReviews } from './services/productReviews';
import { fetchProductModelInfoMap, applyProductModelInfo, normalizePhotoUrl } from './services/productModelInfo';
import CatalogFilters from './components/CatalogFilters';

// Icons using SVG components
const SearchIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
);
const ShoppingBagIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>
);
const XIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
);
const ArrowRightIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
);
const ArrowLeftIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
);
const ArrowUpIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
);
const RulerIcon = () => (
   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12h20"></path><path d="M6 12v-2"></path><path d="M10 12v-2"></path><path d="M14 12v-2"></path><path d="M18 12v-2"></path></svg>
);
const ChevronDownIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
);
const ChevronUpIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
);
const PlayIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
);
const InstagramIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line></svg>
);
const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={filled ? "text-yellow-500" : "text-gray-300"}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
);
const ZoomInIcon = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-md"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
);

const DEFAULT_SETTINGS: SiteSettings = {
  heroTitle: "NEW\nCOLLECTION",
  heroSubtitle: "НОВА КОЛЕКЦІЯ",
  heroBackgroundUrl: "/hero-options/IMG_2275.jpg",
  logoText: "TVIYKOMPLEKT",
  heroDescription: "Естетика. Комфорт. Впевненість. Одяг, який підкреслює твою індивідуальність."
};

type FooterInfoKey = 'delivery' | 'returns' | 'sizing';

const FOOTER_INFO_CONTENT: Record<FooterInfoKey, { title: string; paragraphs: string[] }> = {
  delivery: {
    title: 'Доставка та оплата',
    paragraphs: [
      'Безкоштовна доставка при замовленні від 2500 грн (100% передоплата). Не сумується з іншими акціями та спеціальними пропозиціями.',
    ],
  },
  returns: {
    title: 'Обмін та повернення',
    paragraphs: [
      'Обмін/повернення здійснюється протягом 14 днів з моменту отримання посилки.',
      'Якщо замовлення оформлене післяплатою, на Новій пошті, на жаль, неможливо оплатити лише частину замовлення — посилка оплачується повністю. Якщо одна з позицій не підійшла — ви можете оформити безкоштовний обмін, або повернення протягом 14 днів. Просто напишіть нам, і ми швидко допоможемо з усім процесом.',
      'Обмін/повернення можливий тільки в тому разі, якщо річ у використанні не була, збережене оригінальне пакування, охайний вигляд, не має сторонніх запахів, слідів дезодоранту пилу та шерсті.',
      'Якщо посилка не була отримана на Новій пошті (відмова/не підійшов розмір/зміна моделі), це не вважається обміном, оскільки замовлення не було завершене. У такому випадку оформлюється нове замовлення, а передоплата покриває витрати на доставку та обробку.',
      'Якщо повернення, або обмін здійснюється з вини нашого магазину (наприклад, товар не відповідає замовленню, або бракований товар), доставку оплачуємо ми. В інших випадках вартість доставки оплачує покупець.',
      'Претензії стосовно браку приймаються тільки тоді, коли вони виявлені на пошті. В такому випадку потрібно зробити відмову і повідомити нас про це, щоб ми відправили вам заміну. На замовлення відправлені через поштомат претензії не розглядаються (через відсутність камер та можливості огляду).',
      'Повернення коштів здійснюється протягом 7 робочих днів.',
    ],
  },
  sizing: {
    title: 'Таблиця розмірів',
    paragraphs: [
      'ОГ (обхват грудей) — виміряйте стрічкою горизонтально по найвищих точках грудей.',
      'ОТ (обхват талії) — по найвужчій частині талії, зазвичай на 2-3 см вище пупка.',
      'ОС (обхват стегон) — по найширшій частині стегон і сідниць.',
    ],
  },
};

interface LightboxItem {
    type: 'image' | 'video';
    url: string;
    caption?: string;
}

export default function App() {
  // Data State
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [siteSettings, setSiteSettings] = useState<SiteSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  // UI State
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [selectedColors, setSelectedColors] = useState<Set<string>>(new Set());
  const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set());
  const [priceRange, setPriceRange] = useState<[number, number] | null>(null);
  const [sortOption, setSortOption] = useState<'default' | 'price-asc' | 'price-desc'>('default');
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);
  const priceRangeInitializedRef = useRef(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedSizeForModal, setSelectedSizeForModal] = useState<string>('');
  const [selectedColorForModal, setSelectedColorForModal] = useState<string>('');
  const [colorImageOverride, setColorImageOverride] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(8);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [notification, setNotification] = useState<{message: string, type: 'success' | 'error'} | null>(null);
  
  // Order Form State & Validation
  const [orderForm, setOrderForm] = useState({ firstName: '', lastName: '', phone: '', city: '', branch: '' });
  const [formErrors, setFormErrors] = useState({ firstName: false, lastName: false, phone: false, city: false, branch: false });
  const [showOrderForm, setShowOrderForm] = useState(false);
  
  const [scrolled, setScrolled] = useState(false);
  
  // Modal specific states
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [showSizeTable, setShowSizeTable] = useState(false);
  const [modelInfoExpanded, setModelInfoExpanded] = useState(false);
  const sizeChartRef = useRef<HTMLDivElement>(null);
  const [showVideoAccordion, setShowVideoAccordion] = useState(false);
  const [showReviewsAccordion, setShowReviewsAccordion] = useState(false);
  const [sizeError, setSizeError] = useState(false);

  // Lightbox State
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxItems, setLightboxItems] = useState<LightboxItem[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  // Footer info modal (Доставка / Обмін / Таблиця розмірів)
  const [activeInfoModal, setActiveInfoModal] = useState<FooterInfoKey | null>(null);

  // References
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const variantsLoadedRef = useRef<Set<string>>(new Set());
  const categoryScrollRef = useRef<HTMLDivElement>(null);
  const [showCategoryScrollHint, setShowCategoryScrollHint] = useState(false);

  // Category bar horizontal-scroll hint (mobile): show a fade on the right
  // edge while there's more to scroll, hide it once scrolled to the end.
  const updateCategoryScrollHint = () => {
    const el = categoryScrollRef.current;
    if (!el) return;
    const isOverflowing = el.scrollWidth > el.clientWidth + 1;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    setShowCategoryScrollHint(isOverflowing && !atEnd);
  };

  useEffect(() => {
    updateCategoryScrollHint();
    window.addEventListener('resize', updateCategoryScrollHint);
    return () => window.removeEventListener('resize', updateCategoryScrollHint);
  }, []);

  // Fetch Data Effect
  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true);
        
        // 1. Fetch Site Settings
        try {
          const settingsRef = doc(db, "settings", "site_content");
          const settingsSnap = await getDoc(settingsRef);
          if (settingsSnap.exists()) {
             // Logic to handle potential reset of background URL
            const data = settingsSnap.data();
            const finalSettings = { 
                ...DEFAULT_SETTINGS, 
                ...data,
                // Ensure if heroBackgroundUrl was deleted (undefined), we use the default
                heroBackgroundUrl: data.heroBackgroundUrl || DEFAULT_SETTINGS.heroBackgroundUrl,
                heroDescription: data.heroDescription || DEFAULT_SETTINGS.heroDescription
            };
            setSiteSettings(finalSettings as SiteSettings);
          }
        } catch (err) {
          console.warn("Could not fetch site settings, using defaults", err);
        }

        // 2. Fetch Products from KeyCRM (catalog) + Firestore (point discounts)
        try {
          const [kcProducts, promotions, productMedia, productReviews, productModelInfo] = await Promise.all([
            fetchAllKeycrmProducts(),
            fetchActivePromotions(),
            fetchProductMediaMap(),
            fetchProductReviewsMap(),
            fetchProductModelInfoMap(),
          ]);

          const products = kcProducts
            .slice()
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .map(mapKeycrmProduct);

          // Render the grid immediately with what we have.
          const withOverlays = (p: Product): Product => {
            const id = String(p.id);
            let out = applyPromotion(p, promotions.get(id));
            out = applyProductMedia(out, productMedia.get(id));
            out = applyProductReviews(out, productReviews.get(id));
            return applyProductModelInfo(out, productModelInfo.get(id));
          };
          setAllProducts(products.map(withOverlays));

          // Sizes/colors/variantOffers for the WHOLE catalog, not just products
          // the user has opened - the color filter's swatch list needs every
          // real color up front. Also patches the handful of KeyCRM products
          // that report min_price=0 on the list endpoint even though their
          // offers carry a real price. Cached in sessionStorage so repeat
          // catalog visits within the same tab skip the ~39-page bulk fetch.
          const applyVariantsMap = (variantsMap: Record<string, ProductVariants>) => {
            Object.keys(variantsMap).forEach(id => variantsLoadedRef.current.add(id));
            setAllProducts(prev => prev.map(item => {
              const v = variantsMap[String(item.id)];
              if (!v) return item;
              const withVariants = { ...item, sizes: v.sizes, colors: v.colors, variantOffers: v.variantOffers };
              if (item.price > 0) return withVariants;
              const positivePrices = v.variantOffers.map(o => o.price).filter(p => typeof p === 'number' && p > 0);
              return positivePrices.length > 0
                ? applyPromotion({ ...withVariants, price: Math.min(...positivePrices) }, promotions.get(String(item.id)))
                : withVariants;
            }));
          };

          const cachedVariants = readCachedOfferVariants();
          if (cachedVariants) {
            applyVariantsMap(cachedVariants);
          } else {
            void (async () => {
              try {
                let accumulated: KeycrmOffer[] = [];
                let pageCount = 0;
                const allOffers = await fetchAllKeycrmOffers((pageOffers) => {
                  accumulated = accumulated.concat(pageOffers);
                  pageCount += 1;
                  // Merge incrementally every few pages so the color filter
                  // fills in progressively instead of freezing for ~15-20s.
                  if (pageCount % 5 === 0) {
                    applyVariantsMap(deriveVariantsByProduct(accumulated));
                  }
                });
                const finalMap = deriveVariantsByProduct(allOffers);
                applyVariantsMap(finalMap);
                writeCachedOfferVariants(finalMap);
              } catch (err) {
                console.warn("Could not bulk-load product variants from KeyCRM offers", err);
              }
            })();
          }
        } catch (error) {
          console.error("Error fetching KeyCRM catalog, falling back to static list", error);
          setAllProducts(PRODUCTS);
        }
      } catch (error) {
        console.error("Error fetching data:", error);
        setAllProducts(PRODUCTS);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  // Effects
  useEffect(() => {
    // Load Cart from LocalStorage with Array Validation
    const savedCart = localStorage.getItem('myShopCart');
    if (savedCart) {
      try {
        const parsedCart = JSON.parse(savedCart);
        if (Array.isArray(parsedCart)) {
            setCart(parsedCart);
        } else {
            setCart([]);
        }
      } catch (e) {
        setCart([]);
      }
    }

    // Scroll Handler
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
      setShowScrollTop(window.scrollY > 500);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (Array.isArray(cart)) {
        localStorage.setItem('myShopCart', JSON.stringify(cart));
    }
  }, [cart]);

  // Reset modal state when product changes
  useEffect(() => {
    if (selectedProduct) {
      setCurrentImageIndex(0);
      setShowSizeTable(false);
      setModelInfoExpanded(false);
      setShowVideoAccordion(false);
      setShowReviewsAccordion(false);
      setSelectedSizeForModal('');
      setSelectedColorForModal('');
      setColorImageOverride(null);
      setSizeError(false);
      setIsLightboxOpen(false);
      setLightboxItems([]);
    }
  }, [selectedProduct]);

  // Swap the hero photo for the offer's own thumbnail when a color with one
  // is selected; otherwise fall back to the product's regular gallery.
  useEffect(() => {
    if (!selectedProduct || !selectedColorForModal) {
      setColorImageOverride(null);
      return;
    }
    const offerWithPhoto = (selectedProduct.variantOffers || [])
      .find(o => o.color === selectedColorForModal && o.thumbnailUrl);
    setColorImageOverride(offerWithPhoto ? offerWithPhoto.thumbnailUrl : null);
  }, [selectedColorForModal, selectedProduct]);

  // The plaque belongs to one photo, so swiping the gallery collapses it.
  useEffect(() => {
    setModelInfoExpanded(false);
  }, [currentImageIndex, colorImageOverride]);

  // Lazily load sizes/colors (KeyCRM offers) the first time a product is opened
  useEffect(() => {
    if (!selectedProduct) return;
    const productKey = String(selectedProduct.id);
    if (variantsLoadedRef.current.has(productKey)) return;

    let cancelled = false;
    (async () => {
      try {
        const offers = await fetchOffersForProduct(selectedProduct.id);
        const { sizes, colors, variantOffers } = deriveVariants(offers);
        variantsLoadedRef.current.add(productKey);
        if (cancelled) return;

        setAllProducts(prev => prev.map(p => String(p.id) === productKey ? { ...p, sizes, colors, variantOffers } : p));
        setSelectedProduct(prev => prev && String(prev.id) === productKey ? { ...prev, sizes, colors, variantOffers } : prev);
      } catch (err) {
        console.warn("Could not load product variants from KeyCRM", selectedProduct.id, err);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedProduct?.id]);

  useEffect(() => {
    if (isSearchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isSearchOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setIsSearchOpen(false);
      }
    };

    if (isSearchOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isSearchOpen]);

  // Derived State (Filtering)
  const availableColors = useMemo(() => {
    const set = new Set<string>();
    (allProducts || []).forEach(p => (p.colors || []).forEach(c => set.add(c)));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'uk'));
  }, [allProducts]);

  const availableSizes = useMemo(() => {
    const set = new Set<string>();
    (allProducts || []).forEach(p => (p.sizes || []).forEach(s => set.add(s)));
    return Array.from(set).sort((a, b) => sizeSortKey(a) - sizeSortKey(b) || a.localeCompare(b));
  }, [allProducts]);

  const priceBounds = useMemo<[number, number]>(() => {
    const prices = (allProducts || []).map(p => p.price).filter(p => typeof p === 'number' && p > 0);
    if (prices.length === 0) return [0, 0];
    return [Math.min(...prices), Math.max(...prices)];
  }, [allProducts]);

  // Initialize the price slider to the full catalog range exactly once, the
  // first time real bounds are known - avoids resetting the user's chosen
  // range every time allProducts updates (background price/variant patches).
  useEffect(() => {
    if (priceRangeInitializedRef.current) return;
    if (priceBounds[0] === 0 && priceBounds[1] === 0) return;
    setPriceRange(priceBounds);
    priceRangeInitializedRef.current = true;
  }, [priceBounds]);

  const filteredProducts = useMemo(() => {
    const activeCategoryIds = CATEGORIES.find(c => c.id === activeCategory)?.categoryIds ?? null;
    const filtered = (allProducts || []).filter(product => {
      const matchCategory = activeCategory === 'all'
        || (activeCategoryIds != null
            && product.categoryId != null
            && activeCategoryIds.includes(product.categoryId));
      const matchSearch = product.title.toLowerCase().includes(searchQuery.toLowerCase());
      const matchColor = selectedColors.size === 0
        || (product.colors || []).some(c => selectedColors.has(c));
      const matchSize = selectedSizes.size === 0
        || (product.sizes || []).some(s => selectedSizes.has(s));
      // Products with no resolved price yet ("Ціна уточнюється") always pass
      // the price filter - a price of 0 isn't a comparable number yet.
      const matchPrice = !priceRange || product.price === 0
        || (product.price >= priceRange[0] && product.price <= priceRange[1]);
      return matchCategory && matchSearch && matchColor && matchSize && matchPrice;
    });

    if (sortOption === 'default') return filtered;
    // Unresolved-price ("Ціна уточнюється") products always sort last,
    // regardless of direction - a price of 0 isn't cheapest or priciest.
    const dir = sortOption === 'price-asc' ? 1 : -1;
    return filtered.slice().sort((a, b) => {
      const aHas = a.price > 0, bHas = b.price > 0;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (!aHas) return 0;
      return dir * (a.price - b.price);
    });
  }, [activeCategory, searchQuery, allProducts, selectedColors, selectedSizes, priceRange, sortOption]);

  const displayedProducts = filteredProducts.slice(0, visibleCount);

  // Helpers
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  const getImageUrl = (url: string) => {
    if (!url || url === 'placeholder.jpg') return 'https://picsum.photos/400/500';
    return url.split(',')[0].trim();
  };

  const getEmbedUrl = (videoId: string) => {
      if (!videoId) return "";
      const id = videoId.includes('v=') ? videoId.split('v=')[1] : videoId;
      return `https://www.youtube.com/embed/${id}`;
  }

  const getProductImages = (product: Product | null) => {
      if (!product) return [];
      if (Array.isArray(product.images) && product.images.length > 0) return product.images;
      // @ts-ignore 
      if (product.image) return [product.image];
      return ['https://via.placeholder.com/400x500?text=No+Image'];
  };

  // Cart Logic
  const addToCart = (product: Product, size: string, color?: string) => {
    if (!(product.price > 0)) {
      showToast("❌ Ціна уточнюється, зверніться до менеджера", "error");
      return;
    }
    if (product.sizes && product.sizes.length > 0 && !size) {
      showToast("⚠️ Оберіть розмір!", "error");
      setSizeError(true);
      setTimeout(() => setSizeError(false), 600);
      return;
    }
    if (!isVariantAvailable(color || '', size)) {
      showToast("❌ Цієї комбінації немає в наявності", "error");
      return;
    }
    const finalSize = size || "One Size";
    const newItem: CartItem = { ...product, selectedSize: finalSize, selectedColor: color || undefined, cartId: Date.now() };
    setCart([...(cart || []), newItem]);
    showToast(`✅ ${product.title} додано!`);
    setIsCartOpen(true);
    setSelectedProduct(null);
  };

  const removeFromCart = (index: number) => {
    const newCart = [...cart];
    newCart.splice(index, 1);
    setCart(newCart);
  };

  const cartTotal = (cart || []).reduce((acc, item) => acc + item.price, 0);

  // Validation & Checkout
  const handleInputChange = (field: string, value: string) => {
    setOrderForm(prev => ({ ...prev, [field]: value }));
    // @ts-ignore
    if (formErrors[field]) setFormErrors(prev => ({ ...prev, [field]: false }));
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value.replace(/\D/g, ''); 
    
    // Auto-prefix logic
    if (val.startsWith('0')) val = '38' + val;
    if (val.startsWith('80')) val = '3' + val;
    if (val && !val.startsWith('380')) val = '380' + val;
    
    // Limit length
    val = val.substring(0, 12);
    
    // Formatting: +380 (XX) XXX-XX-XX
    let formatted = '';
    if (val.length > 0) formatted += '+' + val.substring(0, 3);
    if (val.length > 3) formatted += ' (' + val.substring(3, 5);
    if (val.length > 5) formatted += ') ' + val.substring(5, 8);
    if (val.length > 8) formatted += '-' + val.substring(8, 10);
    if (val.length > 10) formatted += '-' + val.substring(10, 12);

    setOrderForm(prev => ({ ...prev, phone: formatted }));
    if (formErrors.phone) setFormErrors(prev => ({ ...prev, phone: false }));
  };

  const handleCheckout = async () => {
    const cleanPhone = orderForm.phone.replace(/\D/g, '');
    const isFirstNameValid = orderForm.firstName.trim().length >= 2;
    const isLastNameValid = orderForm.lastName.trim().length >= 2;
    const isPhoneValid = cleanPhone.length === 12; 
    const isCityValid = orderForm.city.trim().length > 0;
    const isBranchValid = orderForm.branch.trim().length > 0;

    if (!isFirstNameValid || !isLastNameValid || !isPhoneValid || !isCityValid || !isBranchValid) {
        setFormErrors({
            firstName: !isFirstNameValid,
            lastName: !isLastNameValid,
            phone: !isPhoneValid,
            city: !isCityValid,
            branch: !isBranchValid
        });
        showToast("❌ Перевірте правильність даних!", "error");
        return;
    }

    try {
      const response = await fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: {
            firstName: orderForm.firstName,
            lastName: orderForm.lastName,
            phone: orderForm.phone,
            city: orderForm.city,
            branch: orderForm.branch,
          },
          items: (cart || []).map(item => ({
            title: item.title,
            size: item.selectedSize,
            color: item.selectedColor,
            price: item.price,
          })),
          total: cartTotal,
        })
      });

      if (response.ok) {
        showToast("✅ Замовлення прийнято! Менеджер зв'яжеться з вами.");
        setCart([]);
        setOrderForm({ firstName: '', lastName: '', phone: '', city: '', branch: '' });
        setShowOrderForm(false);
        setIsCartOpen(false);
      } else {
        let errorCode = '';
        try {
          const data = await response.json();
          errorCode = (data && data.error) || '';
        } catch (e) {
          // non-JSON error body — fall through to the generic "send" message
        }
        showToast(
          errorCode === 'telegram_unreachable' ? "❌ Помилка з'єднання." : "❌ Помилка відправки.",
          "error"
        );
      }
    } catch (error) {
      showToast("❌ Помилка з'єднання.", "error");
    }
  };

  // The chart is an inline accordion in the right-hand column - below the gallery
  // on mobile - so opening it without scrolling looks like nothing happened. The
  // delay waits out the 300ms max-height transition so the target is full height.
  const openSizeChart = () => {
    setShowSizeTable(true);
    setTimeout(() => sizeChartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 320);
  };

  // Determine which size chart to use
  const activeSizeChart = useMemo(() => {
    if (!selectedProduct) return null;
    
    // PRIORITY 1: Custom Size Chart from Firestore (Array of Objects)
    if (selectedProduct.sizeChart && Array.isArray(selectedProduct.sizeChart) && selectedProduct.sizeChart.length > 0) {
        return { type: 'custom', data: selectedProduct.sizeChart };
    }
    
    // PRIORITY 2: Static Category Chart
    if (selectedProduct.sizeCategory && SIZE_CHARTS[selectedProduct.sizeCategory]) {
        return { type: 'static', data: SIZE_CHARTS[selectedProduct.sizeCategory] }; 
    }
    
    return { type: 'static', data: SIZE_CHARTS['default'] };
  }, [selectedProduct]);

  // KeyCRM `quantity` doesn't reliably mean "in stock" for this shop (89% of
  // real offers sit at quantity<=0 while the product is actively sold —
  // fulfilment is manual, not live-inventory-gated). So "в наявності" here
  // means "this exact color/size combination exists as a real KeyCRM offer",
  // not "quantity > 0". A product with no offer data at all (still loading,
  // or genuinely has none) is treated as available rather than blocking a sale.
  const isVariantAvailable = (color: string, size: string): boolean => {
    const offers = selectedProduct?.variantOffers;
    if (!offers || offers.length === 0) return true;
    return offers.some(o =>
      (!color || o.color === color) &&
      (!size || o.size === size)
    );
  };

  const isCurrentSelectionAvailable = selectedProduct
    ? isVariantAvailable(selectedColorForModal, selectedSizeForModal)
    : true;

  // KeyCRM sometimes reports no positive price for any offer of a product
  // (see getMinOfferPrice in services/keycrm.ts) - price then stays 0.
  const hasValidPrice = selectedProduct ? selectedProduct.price > 0 : true;
  const canAddToCart = isCurrentSelectionAvailable && hasValidPrice;

  const handleSelectColor = (color: string) => {
    setSelectedColorForModal(color);
  };

  // Calculate Average Rating
  const averageRating = useMemo(() => {
    if (!selectedProduct || !Array.isArray(selectedProduct.reviews) || selectedProduct.reviews.length === 0) return 5;
    const total = selectedProduct.reviews.reduce((acc, r) => acc + r.rating, 0);
    return Math.round(total / selectedProduct.reviews.length);
  }, [selectedProduct]);

  // Gather all review media for lightbox
  const allReviewMedia: LightboxItem[] = useMemo(() => {
    if (!selectedProduct || !selectedProduct.reviews) return [];
    return selectedProduct.reviews
      .filter(r => r.url) // Only those with media
      .map(r => ({ type: r.type || 'image', url: r.url!, caption: r.user }));
  }, [selectedProduct]);

  // Generalized Lightbox Opener
  const openLightbox = (items: LightboxItem[], index: number) => {
    if (!items || items.length === 0) return;
    setLightboxItems(items);
    setLightboxIndex(index);
    setIsLightboxOpen(true);
  };

  const nextLightboxMedia = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLightboxIndex(prev => (prev + 1) % lightboxItems.length);
  };

  const prevLightboxMedia = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLightboxIndex(prev => (prev - 1 + lightboxItems.length) % lightboxItems.length);
  };

  return (
    <div className="min-h-screen flex flex-col font-sans">
      {/* Notifications */}
      {notification && (
        <div className={`fixed top-5 right-5 z-[100] px-6 py-4 text-white uppercase text-xs font-bold tracking-widest shadow-lg transition-all transform translate-y-0 ${notification.type === 'error' ? 'bg-red-600' : 'bg-black'}`}>
          {notification.message}
        </div>
      )}

      {/* Header */}
      <header className={`fixed top-0 left-0 w-full z-40 transition-all duration-300 ${scrolled ? 'bg-white/95 backdrop-blur-md shadow-sm py-3' : 'bg-transparent py-5'}`}>
        <div className="container mx-auto px-6 flex justify-between items-center">
          
          {/* Search Trigger */}
          <div className="relative" ref={searchContainerRef}>
             <button 
              className={`p-2 transition-colors duration-300 hover:opacity-70 ${scrolled ? 'text-black' : 'text-white'}`}
              onClick={() => setIsSearchOpen(!isSearchOpen)}
            >
              {isSearchOpen ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              ) : (
                <SearchIcon />
              )}
            </button>
            {isSearchOpen && (
              <div className="absolute top-full left-0 mt-2 w-72 bg-white shadow-xl border border-gray-100 p-2 rounded-sm animate-fade-in-down z-50">
                 <input 
                  ref={searchInputRef}
                  type="text" 
                  placeholder="Я шукаю..."
                  className="w-full p-2 text-base border-b border-gray-200 outline-none focus:border-black transition-colors bg-transparent"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setActiveCategory('all');
                    window.scrollTo({ top: 600, behavior: 'smooth' }); 
                  }}
                 />
              </div>
            )}
          </div>

          {/* Logo */}
          <div 
            className={`font-serif text-2xl md:text-3xl font-bold tracking-widest cursor-pointer transition-colors duration-300 ${scrolled ? 'text-black' : 'text-white'}`}
            onClick={() => {
              setActiveCategory('all');
              setSearchQuery('');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            {siteSettings.logoText}
          </div>

          {/* Cart Trigger */}
          <button 
            className={`p-2 relative transition-colors duration-300 hover:opacity-70 ${scrolled ? 'text-black' : 'text-white'}`}
            onClick={() => setIsCartOpen(true)}
          >
            <ShoppingBagIcon />
            {cart && cart.length > 0 && (
              <span className={`absolute -top-1 -right-1 text-[10px] font-bold h-4 w-4 flex items-center justify-center rounded-full ${scrolled ? 'bg-black text-white' : 'bg-white text-black'}`}>
                {cart.length}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative h-[600px] md:h-[80vh] w-full bg-gray-900 overflow-hidden flex items-center justify-center md:justify-start">
        <div className="absolute inset-0 z-0">
            {/* Background Image with Fallback */}
            {(() => {
                const heroUrl = siteSettings.heroBackgroundUrl || DEFAULT_SETTINGS.heroBackgroundUrl;
                // Optional WebP sibling next to a .jpg/.jpeg/.png hero photo (same
                // basename) - if it 404s the <picture> just falls through to the
                // <img> below, so this is safe even for admin-set URLs with no
                // matching .webp file.
                const heroWebpUrl = /\.(jpe?g|png)$/i.test(heroUrl) ? heroUrl.replace(/\.(jpe?g|png)$/i, '.webp') : null;
                return (
                <picture>
                {heroWebpUrl && <source srcSet={heroWebpUrl} type="image/webp" />}
                <img
                src={heroUrl}
                alt="Hero Background"
                // md:-only zoom+re-anchor: on the very wide desktop banner this
                // portrait photo's full width is already shown by object-fit:cover
                // (only height gets cropped), so object-position alone can't shift
                // her horizontally - scale+transformOrigin zooms in and re-anchors
                // the crop toward her, pushing her clear of the text panel. Left
                // desktop-only because on the mobile banner's narrower aspect ratio
                // she's already in frame without it, and applying the same zoom
                // there pushes her almost entirely behind the (much wider relative
                // to the banner) text panel.
                className="w-full h-full object-cover opacity-80 md:scale-[1.3] md:origin-[11%_50%]"
                style={{ objectPosition: '50% 60%' }}
                />
                </picture>
                );
            })()}
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent"></div>
        </div>
        
        <div className="relative z-10 px-6 md:pl-24 max-w-2xl text-center md:text-left">
            <div className="backdrop-blur-md bg-white/10 p-8 md:p-12 border border-white/20 shadow-2xl">
                {/* STATIC CLASSES, DYNAMIC CONTENT */}
                <span className="block text-xs md:text-sm tracking-[0.3em] text-white/90 mb-4 uppercase">
                    {siteSettings.heroSubtitle || "НОВА КОЛЕКЦІЯ"}
                </span>
                <h1 className="font-serif text-4xl md:text-6xl text-white font-bold mb-6 leading-tight whitespace-pre-line">
                    {siteSettings.heroTitle || "NEW\nCOLLECTION"}
                </h1>
                
                <p className="text-white/80 mb-8 text-sm md:text-base leading-relaxed">
                    {siteSettings.heroDescription || "Естетика. Комфорт. Впевненість. Одяг, який підкреслює твою індивідуальність."}
                </p>
                <button 
                    onClick={() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth' })}
                    className="bg-white text-black px-8 py-4 text-xs font-bold uppercase tracking-widest hover:bg-black hover:text-white transition-all duration-300"
                >
                    Перейти до каталогу
                </button>
            </div>
        </div>
      </section>

      {/* Main Content */}
      <main id="catalog" className="flex-grow container mx-auto px-4 py-12">
        
        {/* Categories */}
        <div className="sticky top-[70px] z-30 relative mb-8">
            <div
                ref={categoryScrollRef}
                onScroll={updateCategoryScrollHint}
                className="bg-white/90 backdrop-blur-sm py-4 border-b border-gray-100 overflow-x-auto no-scrollbar"
            >
                <div className="flex justify-start md:justify-center gap-4 min-w-max px-4">
                    {CATEGORIES.map(cat => (
                        <button
                            key={cat.id}
                            onClick={() => {
                                setActiveCategory(cat.id);
                                setVisibleCount(8);
                            }}
                            className={`text-xs uppercase tracking-widest px-4 py-2 transition-all duration-300 ${
                                activeCategory === cat.id
                                ? 'text-black border-b-2 border-black font-semibold'
                                : 'text-gray-500 hover:text-black'
                            }`}
                        >
                            {cat.label}
                        </button>
                    ))}
                </div>
            </div>
            {/* Fade hint that there's more to scroll horizontally - a sibling of
                the scrolling element (not a descendant), so it stays pinned to
                the edge regardless of scrollLeft. Fades out at the end. */}
            <div
                className={`pointer-events-none absolute top-0 right-0 bottom-0 w-10 bg-gradient-to-l from-white to-transparent transition-opacity duration-300 ${
                    showCategoryScrollHint ? 'opacity-100' : 'opacity-0'
                }`}
            />
        </div>

        <div className="flex flex-col md:flex-row gap-8 items-start">
          {/* Desktop filter sidebar */}
          <aside className="hidden md:block w-64 shrink-0 sticky top-[150px]">
            <CatalogFilters
              categories={CATEGORIES}
              activeCategory={activeCategory}
              onSelectCategory={(id) => { setActiveCategory(id); setVisibleCount(8); }}
              availableColors={availableColors}
              selectedColors={selectedColors}
              onToggleColor={(color) => setSelectedColors(prev => {
                const next = new Set(prev);
                if (next.has(color)) next.delete(color); else next.add(color);
                return next;
              })}
              availableSizes={availableSizes}
              selectedSizes={selectedSizes}
              onToggleSize={(size) => setSelectedSizes(prev => {
                const next = new Set(prev);
                if (next.has(size)) next.delete(size); else next.add(size);
                return next;
              })}
              priceBounds={priceBounds}
              priceRange={priceRange ?? priceBounds}
              onChangePriceRange={setPriceRange}
              sortOption={sortOption}
              onChangeSort={setSortOption}
              onReset={() => { setActiveCategory('all'); setVisibleCount(8); setSelectedColors(new Set()); setSelectedSizes(new Set()); setPriceRange(priceBounds); setSortOption('default'); }}
            />
          </aside>

          <div className="flex-1 min-w-0">
            {/* Mobile filters button */}
            <div className="md:hidden mb-6 flex justify-end">
              <button
                onClick={() => setIsFilterSheetOpen(true)}
                className="flex items-center gap-2 border border-black px-5 py-2 text-xs uppercase tracking-widest hover:bg-black hover:text-white transition-all duration-300"
              >
                Фільтри
                {(selectedColors.size > 0 || selectedSizes.size > 0 || (priceRange != null && (priceRange[0] !== priceBounds[0] || priceRange[1] !== priceBounds[1])) || sortOption !== 'default') && (
                  <span className="w-2 h-2 rounded-full bg-red-600" />
                )}
              </button>
            </div>

        {/* Product Grid */}
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
             <div className="loader mb-4 border-4 border-gray-200 border-t-black rounded-full w-8 h-8 animate-spin"></div>
             <p className="text-xs uppercase tracking-widest">Завантаження товарів...</p>
          </div>
        ) : displayedProducts.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-8">
                {(displayedProducts || []).map(product => {
                    const images = getProductImages(product);
                    return (
                        <div key={product.id} className="group cursor-pointer" onClick={() => {
                            setSelectedProduct(product);
                        }}>
                            <div className="relative overflow-hidden bg-gray-100 aspect-[4/5] mb-4">
                                <img 
                                    src={getImageUrl(images[0])} 
                                    alt={product.title} 
                                    className="w-full h-full object-cover object-top transition-transform duration-700 group-hover:scale-105"
                                    loading="lazy"
                                />
                                
                                {/* Badges Container - Top Left Stacked */}
                                <div className="absolute top-2 left-2 flex flex-col gap-1 items-start z-10">
                                    {product.isNew && (
                                         <div className="bg-black text-white text-[10px] font-bold px-2 py-1 uppercase tracking-widest shadow-sm">
                                            NEW
                                         </div>
                                    )}
                                    {product.oldPrice && product.oldPrice > product.price && (
                                        <div className="bg-red-600 text-white text-[10px] font-bold px-2 py-1 uppercase tracking-widest shadow-sm">
                                            {product.badgeText || 'SALE'}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <h3 className="text-xs uppercase tracking-wide text-gray-900 truncate mb-1 pr-2">{product.title}</h3>
                            <div className="flex items-center gap-2">
                                {product.price > 0 ? (
                                    <>
                                        {product.oldPrice && product.oldPrice > product.price && (
                                            <span className="text-xs text-gray-400 line-through">{product.oldPrice} UAH</span>
                                        )}
                                        <span className={`text-sm font-semibold ${product.oldPrice ? 'text-red-600' : 'text-gray-900'}`}>{product.price} UAH</span>
                                    </>
                                ) : (
                                    <span className="text-sm font-semibold text-gray-400">Ціна уточнюється</span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        ) : (
            <div className="text-center py-20 text-gray-400">
                <p>Товарів не знайдено :(</p>
                <button 
                    onClick={() => { setSearchQuery(''); setActiveCategory('all'); setSelectedColors(new Set()); setSelectedSizes(new Set()); setPriceRange(priceBounds); setSortOption('default'); }}
                    className="mt-4 text-black underline text-sm"
                >
                    Скинути фільтри
                </button>
            </div>
        )}

        {/* Load More */}
        {!isLoading && visibleCount < filteredProducts.length && (
            <div className="text-center mt-12">
                <button 
                    onClick={() => setVisibleCount(prev => prev + 8)}
                    className="border border-black px-10 py-3 text-xs uppercase tracking-widest hover:bg-black hover:text-white transition-all duration-300"
                >
                    Показати ще ↓
                </button>
            </div>
        )}
          </div>
        </div>

      </main>

      {/* Mobile Filters Bottom Sheet */}
      {isFilterSheetOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex items-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setIsFilterSheetOpen(false)}></div>
          <div className="relative bg-white w-full max-h-[85vh] overflow-y-auto rounded-t-2xl p-6 pb-8 shadow-2xl animate-fade-in-up">
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-serif text-xl">Фільтри</h3>
              <button onClick={() => setIsFilterSheetOpen(false)} className="p-2 hover:opacity-70 transition-opacity">
                <XIcon />
              </button>
            </div>
            <CatalogFilters
              categories={CATEGORIES}
              activeCategory={activeCategory}
              onSelectCategory={(id) => { setActiveCategory(id); setVisibleCount(8); }}
              availableColors={availableColors}
              selectedColors={selectedColors}
              onToggleColor={(color) => setSelectedColors(prev => {
                const next = new Set(prev);
                if (next.has(color)) next.delete(color); else next.add(color);
                return next;
              })}
              availableSizes={availableSizes}
              selectedSizes={selectedSizes}
              onToggleSize={(size) => setSelectedSizes(prev => {
                const next = new Set(prev);
                if (next.has(size)) next.delete(size); else next.add(size);
                return next;
              })}
              priceBounds={priceBounds}
              priceRange={priceRange ?? priceBounds}
              onChangePriceRange={setPriceRange}
              sortOption={sortOption}
              onChangeSort={setSortOption}
              onReset={() => { setActiveCategory('all'); setVisibleCount(8); setSelectedColors(new Set()); setSelectedSizes(new Set()); setPriceRange(priceBounds); setSortOption('default'); }}
            />
            <button
              onClick={() => setIsFilterSheetOpen(false)}
              className="mt-8 w-full bg-black text-white py-4 uppercase tracking-widest text-xs font-bold hover:bg-gray-800 transition-colors"
            >
              Показати {filteredProducts.length} товарів
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="bg-black text-white pt-16 pb-8 px-6 mt-12">
        <div className="container mx-auto grid grid-cols-1 md:grid-cols-3 gap-12 border-b border-gray-800 pb-12">
            <div>
                <h3 className="font-serif text-2xl mb-6">{siteSettings.logoText}</h3>
                <p className="text-gray-400 text-sm leading-relaxed mb-6">
                    Створюємо одяг, який підкреслює твою індивідуальність. Якість у кожному шві.
                </p>
            </div>
            {/* Footer Links (open the info modal below instead of navigating) */}
            <div>
                <h4 className="font-bold text-sm uppercase tracking-widest mb-6">Клієнтам</h4>
                <ul className="space-y-3 text-sm text-gray-400">
                    <li><a href="#" onClick={(e) => { e.preventDefault(); setActiveInfoModal('delivery'); }} className="hover:text-white transition-colors">Доставка та оплата</a></li>
                    <li><a href="#" onClick={(e) => { e.preventDefault(); setActiveInfoModal('returns'); }} className="hover:text-white transition-colors">Обмін та повернення</a></li>
                    <li><a href="#" onClick={(e) => { e.preventDefault(); setActiveInfoModal('sizing'); }} className="hover:text-white transition-colors">Таблиця розмірів</a></li>
                </ul>
            </div>
            <div>
                <h4 className="font-bold text-sm uppercase tracking-widest mb-6">Контакти</h4>
                <p className="text-sm text-gray-400 mb-3">Зв'яжіться з нами в Instagram</p>
                <a
                    href="https://www.instagram.com/tviykomplekt/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-white hover:text-gray-300 transition-colors"
                >
                    <InstagramIcon /> @tviykomplekt
                </a>
            </div>
        </div>
        <div className="text-center pt-8 text-xs text-gray-600">
            &copy; {new Date().getFullYear()} {siteSettings.logoText}. Всі права захищено.
        </div>
      </footer>

      {/* Footer Info Modal (Доставка / Обмін / Таблиця розмірів) */}
      {activeInfoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setActiveInfoModal(null)}></div>
            <div className="relative bg-white w-full max-w-lg max-h-[85vh] rounded-sm overflow-hidden flex flex-col shadow-2xl animate-fade-in-up">
                <button
                    onClick={() => setActiveInfoModal(null)}
                    className="absolute top-4 right-4 z-50 p-2 bg-white/80 rounded-full hover:bg-white shadow-sm"
                >
                    <XIcon />
                </button>
                <div className="flex-1 overflow-y-auto p-8 md:p-10">
                    <h2 className="font-serif text-2xl mb-6">{FOOTER_INFO_CONTENT[activeInfoModal].title}</h2>
                    <div className="space-y-4">
                        {FOOTER_INFO_CONTENT[activeInfoModal].paragraphs.map((paragraph, idx) => (
                            <p key={idx} className="text-sm text-gray-700 leading-relaxed">{paragraph}</p>
                        ))}
                    </div>
                </div>
            </div>
        </div>
      )}

      {/* Scroll To Top Button */}
      <button 
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        className={`fixed bottom-8 right-8 z-40 bg-black text-white p-3 rounded-full shadow-lg transition-all duration-300 transform hover:bg-gray-800 ${
          showScrollTop ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10 pointer-events-none'
        }`}
      >
        <ArrowUpIcon />
      </button>

      {/* Product Modal */}
      {selectedProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setSelectedProduct(null)}></div>
            <div className="relative bg-white w-full max-w-6xl h-[95vh] rounded-sm overflow-hidden flex flex-col shadow-2xl animate-fade-in-up">
                
                <button 
                    onClick={() => setSelectedProduct(null)}
                    className="absolute top-4 right-4 z-50 p-2 bg-white/80 rounded-full hover:bg-white shadow-sm"
                >
                    <XIcon />
                </button>

                <div className="flex-1 overflow-y-auto">
                    <div className="flex flex-col md:flex-row md:h-full">
                        {/* Gallery */}
                        <div className="w-full md:w-1/2 bg-gray-50 p-4 md:p-8 flex flex-col h-[50vh] md:h-auto">
                           {(() => {
                               const images = getProductImages(selectedProduct);
                               // Prepare image objects for the lightbox
                               const productLightboxItems: LightboxItem[] = images.map(url => ({ type: 'image', url }));

                               // Whatever the hero <img> is actually showing. A color-specific
                               // offer thumbnail isn't part of the gallery, so it simply has no
                               // entry and no plaque appears.
                               const shownUrl = colorImageOverride || images[currentImageIndex] || images[0];
                               const modelInfo = selectedProduct.modelInfoByUrl?.[normalizePhotoUrl(shownUrl)];
                               const modelInfoDetails = modelInfo
                                   ? [
                                       modelInfo.bust !== undefined ? { label: 'Груди', value: modelInfo.bust } : null,
                                       modelInfo.waist !== undefined ? { label: 'Талія', value: modelInfo.waist } : null,
                                       modelInfo.hips !== undefined ? { label: 'Стегна', value: modelInfo.hips } : null,
                                     ].filter(Boolean) as { label: string; value: number }[]
                                   : [];
                               const canExpand = !!modelInfo && (modelInfoDetails.length > 0 || !!modelInfo.note);

                               return (
                                   <>
                                       <div 
                                            className="flex-1 relative overflow-hidden bg-white shadow-sm aspect-[4/5] md:aspect-auto cursor-zoom-in group"
                                            onClick={() => openLightbox(productLightboxItems, currentImageIndex)}
                                       >
                                            {images && images.length > 0 && (
                                                <>
                                                    <img
                                                        src={getImageUrl(colorImageOverride || images[currentImageIndex] || images[0])}
                                                        alt={selectedProduct.title}
                                                        className="w-full h-full object-contain object-center bg-gray-50 transition-transform duration-300"
                                                    />
                                                    <div className="absolute top-4 left-4 bg-white/80 p-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                                                        <ZoomInIcon />
                                                    </div>
                                                </>
                                            )}
                                            {images && images.length > 1 && (
                                                <>
                                                    <button 
                                                        className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/70 p-2 hover:bg-white rounded-full shadow-sm transition-all z-10"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setCurrentImageIndex(prev => prev === 0 ? images.length - 1 : prev - 1);
                                                        }}
                                                    >
                                                        <ArrowLeftIcon />
                                                    </button>
                                                    <button 
                                                        className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/70 p-2 hover:bg-white rounded-full shadow-sm transition-all z-10"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setCurrentImageIndex(prev => (prev + 1) % images.length);
                                                        }}
                                                    >
                                                        <ArrowRightIcon />
                                                    </button>
                                                </>
                                            )}

                                            {modelInfo && (
                                                <div
                                                    className="absolute bottom-3 left-3 z-10 max-w-[calc(100%-1.5rem)] cursor-default"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    <div className="bg-white/85 backdrop-blur-sm rounded shadow-sm text-gray-800 overflow-hidden">
                                                        <div className="flex items-stretch divide-x divide-black/10">
                                                            {canExpand ? (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setModelInfoExpanded(prev => !prev)}
                                                                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] leading-tight text-left font-medium hover:bg-white/60 transition-colors"
                                                                >
                                                                    Зріст {modelInfo.height} см · розмір {modelInfo.size}
                                                                    <span className={`transition-transform duration-200 ${modelInfoExpanded ? 'rotate-180' : ''}`}>
                                                                        <ChevronDownIcon />
                                                                    </span>
                                                                </button>
                                                            ) : (
                                                                <span className="px-2.5 py-1.5 text-[11px] leading-tight font-medium">
                                                                    Зріст {modelInfo.height} см · розмір {modelInfo.size}
                                                                </span>
                                                            )}
                                                            <button
                                                                type="button"
                                                                onClick={openSizeChart}
                                                                className="px-2.5 py-1.5 text-[11px] leading-tight whitespace-nowrap text-gray-600 hover:bg-white/60 hover:text-black transition-colors"
                                                            >
                                                                Розмірна сітка
                                                            </button>
                                                        </div>

                                                        {canExpand && modelInfoExpanded && (
                                                            <div className="px-2.5 py-2 border-t border-black/10 text-[11px] leading-snug space-y-0.5 animate-fade-in">
                                                                {modelInfoDetails.map(detail => (
                                                                    <div key={detail.label} className="flex justify-between gap-4">
                                                                        <span className="text-gray-500">{detail.label}</span>
                                                                        <span className="font-medium">{detail.value} см</span>
                                                                    </div>
                                                                ))}
                                                                {modelInfo.note && (
                                                                    <p className={`text-gray-600 ${modelInfoDetails.length > 0 ? 'pt-1 mt-1 border-t border-black/5' : ''}`}>
                                                                        {modelInfo.note}
                                                                    </p>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                       </div>
                                       
                                       {/* Thumbnails */}
                                       {images && images.length > 1 && (
                                           <div className="mt-4 h-20 flex gap-2 overflow-x-auto no-scrollbar pb-2">
                                               {images.map((img, idx) => (
                                                   <button 
                                                       key={idx} 
                                                       onClick={() => setCurrentImageIndex(idx)}
                                                       className={`relative flex-shrink-0 aspect-[4/5] h-full overflow-hidden border-2 transition-all ${currentImageIndex === idx ? 'border-black opacity-100' : 'border-transparent opacity-60 hover:opacity-100'}`}
                                                   >
                                                       <img src={getImageUrl(img)} className="w-full h-full object-cover" alt="thumb"/>
                                                   </button>
                                               ))}
                                           </div>
                                       )}
                                   </>
                               );
                           })()}
                        </div>

                        {/* Info */}
                        <div className="w-full md:w-1/2 p-6 md:p-10 flex flex-col bg-white md:overflow-y-auto">
                            <div className="mb-6">
                                <h2 className="font-serif text-2xl md:text-3xl mb-1 leading-tight">{selectedProduct.title}</h2>
                                <div className="flex items-center gap-2 mb-3">
                                    <div className="flex text-yellow-500 text-sm">
                                        {'★'.repeat(averageRating)}{'☆'.repeat(5-averageRating)}
                                    </div>
                                    <span className="text-xs text-gray-500 font-medium">({selectedProduct.reviews?.length || 0} відгуків)</span>
                                </div>
                                <div className="flex items-end gap-3">
                                    {hasValidPrice ? (
                                        <>
                                            {selectedProduct.oldPrice && selectedProduct.oldPrice > selectedProduct.price && (
                                                <span className="text-lg text-gray-400 line-through">{selectedProduct.oldPrice} UAH</span>
                                            )}
                                            <p className={`text-xl font-bold ${selectedProduct.oldPrice ? 'text-red-600' : 'text-black'}`}>{selectedProduct.price} UAH</p>
                                            {selectedProduct.oldPrice && selectedProduct.oldPrice > selectedProduct.price && (
                                                <span className="bg-red-600 text-white text-[10px] font-bold px-2 py-1 uppercase tracking-widest">
                                                    {selectedProduct.badgeText || 'SALE'}
                                                </span>
                                            )}
                                        </>
                                    ) : (
                                        <p className="text-xl font-bold text-gray-400">Ціна уточнюється</p>
                                    )}
                                </div>
                            </div>

                            <div className="text-gray-600 text-sm leading-relaxed border-t border-gray-100 py-6 mb-6">
                                <p className="whitespace-pre-line">{selectedProduct.description || DEFAULT_PRODUCT_DESCRIPTION}</p>
                            </div>

                            {/* Color Selection — real KeyCRM offer colors */}
                            {selectedProduct.colors && selectedProduct.colors.length > 0 && (
                                <div className="mb-6">
                                    <p className="text-xs uppercase font-bold tracking-wider mb-2">
                                        Оберіть колір: <span className="text-gray-500 font-normal">{selectedColorForModal || ''}</span>
                                    </p>
                                    <div className="flex flex-wrap gap-3">
                                        {selectedProduct.colors.map(color => {
                                            const hex = COLOR_HEX[color];
                                            return (
                                                <button
                                                    key={color}
                                                    onClick={() => handleSelectColor(color)}
                                                    className="group w-11 h-11 flex items-center justify-center"
                                                    title={color}
                                                    aria-label={color}
                                                >
                                                    <span
                                                        className={`w-8 h-8 rounded-full border transition-all duration-200 flex items-center justify-center ${
                                                            selectedColorForModal === color
                                                            ? 'ring-2 ring-offset-2 ring-black scale-110 shadow-sm'
                                                            : 'group-hover:scale-110 group-hover:shadow-sm'
                                                        } ${hex ? 'border-gray-200' : 'border-gray-300 bg-gray-100'}`}
                                                        style={hex ? { backgroundColor: hex } : undefined}
                                                    >
                                                        {!hex && <span className="text-[8px] text-gray-500">?</span>}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Sizes & Chart */}
                            <div className="mb-6" ref={sizeChartRef}>
                                <div className="flex justify-between items-center mb-3">
                                    <p className={`text-xs uppercase font-bold tracking-wider transition-colors ${sizeError ? 'text-red-500' : 'text-gray-900'}`}>
                                        {sizeError ? '⚠️ Оберіть розмір:' : 'Оберіть розмір:'}
                                    </p>
                                    <button 
                                        onClick={() => setShowSizeTable(!showSizeTable)}
                                        className="text-xs flex items-center gap-1 underline text-gray-500 hover:text-black transition-colors"
                                    >
                                        <RulerIcon /> {showSizeTable ? 'Сховати' : 'Таблиця розмірів'}
                                    </button>
                                </div>

                                {/* Dynamic Size Table */}
                                <div className={`overflow-hidden transition-all duration-300 ease-in-out ${showSizeTable ? 'max-h-96 opacity-100 mb-4' : 'max-h-0 opacity-0'}`}>
                                    {activeSizeChart ? (
                                        <div className="bg-gray-50 p-4 rounded text-xs border border-gray-100">
                                            <table className="w-full text-left">
                                                <thead>
                                                    <tr className="border-b border-gray-200 text-gray-500">
                                                        {activeSizeChart.type === 'custom' ? (
                                                            <>
                                                                <th className="py-2 px-2 font-medium">Розмір</th>
                                                                <th className="py-2 px-2 font-medium">Груди</th>
                                                                <th className="py-2 px-2 font-medium">Талія</th>
                                                                <th className="py-2 px-2 font-medium">Стегна</th>
                                                            </>
                                                        ) : (
                                                            // @ts-ignore - Handle legacy static chart structure
                                                            activeSizeChart.data.columns.map((col: string, i: number) => (
                                                                <th key={i} className="py-2 px-2 font-medium">{col}</th>
                                                            ))
                                                        )}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {activeSizeChart.type === 'custom' ? (
                                                        // @ts-ignore
                                                        activeSizeChart.data.map((row: SizeChartRow, i: number) => (
                                                            <tr key={i} className="border-b border-gray-100 last:border-0 hover:bg-gray-100/50">
                                                                <td className="py-2 px-2 text-gray-700 font-medium">{row.size}</td>
                                                                <td className="py-2 px-2 text-gray-700 font-medium">{row.bust}</td>
                                                                <td className="py-2 px-2 text-gray-700 font-medium">{row.waist}</td>
                                                                <td className="py-2 px-2 text-gray-700 font-medium">{row.hips}</td>
                                                            </tr>
                                                        ))
                                                    ) : (
                                                        // @ts-ignore
                                                        activeSizeChart.data.rows.map((row: string[], i: number) => (
                                                            <tr key={i} className="border-b border-gray-100 last:border-0 hover:bg-gray-100/50">
                                                                {row.map((cell, j) => (
                                                                    <td key={j} className="py-2 px-2 text-gray-700 font-medium">{cell}</td>
                                                                ))}
                                                            </tr>
                                                        ))
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    ) : (
                                        <p className="text-xs text-red-500">Таблиця розмірів відсутня.</p>
                                    )}
                                </div>

                                <div className={`flex flex-wrap gap-3 p-2 rounded transition-all duration-300 ${sizeError ? 'input-error bg-red-50' : 'border border-transparent'}`}>
                                    {selectedProduct.sizes && selectedProduct.sizes.length > 0 ? selectedProduct.sizes.map(size => {
                                        const available = isVariantAvailable(selectedColorForModal, size);
                                        return (
                                            <button
                                                key={size}
                                                disabled={!available}
                                                onClick={() => {
                                                    setSelectedSizeForModal(size);
                                                    setSizeError(false);
                                                }}
                                                title={available ? undefined : 'Немає в наявності для обраного кольору'}
                                                className={`w-12 h-12 flex items-center justify-center border text-sm transition-all duration-200 ${
                                                    !available
                                                    ? 'border-gray-100 text-gray-300 cursor-not-allowed line-through'
                                                    : selectedSizeForModal === size
                                                        ? 'border-black bg-black text-white shadow-md transform scale-105'
                                                        : 'border-gray-200 hover:border-black text-gray-700'
                                                }`}
                                            >
                                                {size}
                                            </button>
                                        );
                                    }) : (
                                        <span className="text-sm text-gray-500 italic">Універсальний розмір</span>
                                    )}
                                </div>
                            </div>

                            {/* Stock indicator — binary by design (no exact counts): whether this
                                exact color/size combination exists as a real KeyCRM offer. */}
                            {(selectedSizeForModal || selectedColorForModal) && (
                                <p className={`text-xs font-medium mb-3 ${isCurrentSelectionAvailable ? 'text-green-700' : 'text-red-600'}`}>
                                    {isCurrentSelectionAvailable ? '✅ В наявності' : '❌ Немає в наявності'}
                                </p>
                            )}

                            {/* Buy Button */}
                            <button
                                onClick={() => addToCart(selectedProduct, selectedSizeForModal, selectedColorForModal)}
                                disabled={!canAddToCart}
                                className={`w-full py-4 uppercase tracking-widest text-sm font-bold transition-colors shadow-lg mb-6 ${
                                    canAddToCart
                                    ? 'bg-black text-white hover:bg-gray-800'
                                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                                }`}
                            >
                                {hasValidPrice ? 'Додати в кошик' : 'Ціна уточнюється'}
                            </button>

                            {/* Video Accordion */}
                            {selectedProduct.videoId && (
                              <div className="border-t border-gray-200">
                                <button 
                                  onClick={() => setShowVideoAccordion(!showVideoAccordion)}
                                  className="w-full py-4 flex justify-between items-center text-left text-xs uppercase font-bold tracking-wider hover:text-black transition-colors"
                                >
                                  <span className="flex items-center gap-2"> <PlayIcon /> Дивитись відеоогляд</span>
                                  {showVideoAccordion ? <ChevronUpIcon /> : <ChevronDownIcon />}
                                </button>
                                <div className={`overflow-hidden transition-all duration-500 ease-in-out ${showVideoAccordion ? 'max-h-[560px] opacity-100 pb-6' : 'max-h-0 opacity-0'}`}>
                                   <div className="aspect-[9/16] w-[280px] max-w-full mx-auto bg-black rounded-sm overflow-hidden shadow-lg">
                                      <iframe
                                          src={getEmbedUrl(selectedProduct.videoId)}
                                          title="Video review"
                                          className="w-full h-full"
                                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                          allowFullScreen
                                      ></iframe>
                                   </div>
                                </div>
                              </div>
                            )}

                            {/* Extra Video Reviews (admin-uploaded, productMedia.videos) */}
                            {selectedProduct.extraVideos && selectedProduct.extraVideos.length > 0 && (
                              <div className="border-t border-gray-200 pt-4 pb-2">
                                <p className="text-xs uppercase font-bold tracking-wider mb-3 flex items-center gap-2">
                                  <PlayIcon /> Відео-огляди
                                </p>
                                <div className="space-y-3">
                                  {selectedProduct.extraVideos.map((url, i) => (
                                    <video key={i} src={url} controls playsInline className="aspect-[9/16] w-[280px] max-w-full mx-auto rounded-sm shadow-sm bg-black" />
                                  ))}
                                </div>
                              </div>
                            )}

                             {/* Reviews Accordion */}
                            <div className="border-t border-gray-200 border-b mb-6">
                              <button 
                                onClick={() => setShowReviewsAccordion(!showReviewsAccordion)}
                                className="w-full py-4 flex justify-between items-center text-left text-xs uppercase font-bold tracking-wider hover:text-black transition-colors"
                              >
                                <span className="flex items-center gap-2"> 
                                    <StarIcon filled={true} /> 
                                    Відгуки клієнтів ({selectedProduct.reviews?.length || 0})
                                </span>
                                {showReviewsAccordion ? <ChevronUpIcon /> : <ChevronDownIcon />}
                              </button>
                              <div className={`overflow-hidden transition-all duration-500 ease-in-out ${showReviewsAccordion ? 'max-h-[500px] opacity-100 pb-6 overflow-y-auto' : 'max-h-0 opacity-0'}`}>
                                   {selectedProduct.reviews && selectedProduct.reviews.length > 0 ? (
                                     <div className="space-y-4">
                                       {selectedProduct.reviews.map((review, i) => (
                                          <div key={i} className="bg-gray-50 p-4 rounded-sm border border-gray-100">
                                              <div className="flex justify-between items-start mb-2">
                                                 <div>
                                                    <span className="font-bold text-sm">{review.user}</span>
                                                    {review.date && <span className="text-gray-400 text-xs ml-2">{review.date}</span>}
                                                 </div>
                                                 <div className="flex text-yellow-500 text-xs">
                                                    {'★'.repeat(review.rating)}{'☆'.repeat(5-review.rating)}
                                                 </div>
                                              </div>
                                              <p className="text-gray-600 text-sm italic">"{review.text}"</p>
                                              {/* Review Media Thumbnail - Triggers Unified Lightbox */}
                                              {review.url && (
                                                 <div 
                                                    className="mt-3 w-24 h-24 rounded overflow-hidden border border-gray-200 cursor-pointer hover:opacity-90 relative group"
                                                    onClick={() => {
                                                        const targetIndex = allReviewMedia.findIndex(item => item.url === review.url);
                                                        openLightbox(allReviewMedia, targetIndex !== -1 ? targetIndex : 0);
                                                    }}
                                                  >
                                                     {review.type === 'video' ? (
                                                         <div className="w-full h-full bg-black flex items-center justify-center text-white"><PlayIcon /></div>
                                                     ) : (
                                                         <img src={review.url} className="w-full h-full object-cover" alt="Review attachment" />
                                                     )}
                                                     <div className="absolute inset-0 bg-black/20 group-hover:bg-transparent transition-colors flex items-center justify-center">
                                                         <ZoomInIcon />
                                                     </div>
                                                 </div>
                                              )}
                                          </div>
                                       ))}
                                     </div>
                                   ) : (
                                      <p className="text-sm text-gray-400 italic py-2">Ще немає відгуків. Станьте першим!</p>
                                   )}
                              </div>
                            </div>
                            
                        </div>
                    </div>
                </div>
            </div>
        </div>
      )}

      {/* Unified Lightbox Modal */}
      {isLightboxOpen && lightboxItems.length > 0 && (
        <div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center animate-fade-in select-none">
           {/* Close Button */}
           <button 
             onClick={() => setIsLightboxOpen(false)}
             className="absolute top-4 right-4 text-white hover:text-gray-300 z-50 p-2"
           >
             <XIcon />
           </button>

           {/* Navigation Buttons */}
           {lightboxItems.length > 1 && (
             <>
               <button 
                  onClick={prevLightboxMedia}
                  className="absolute left-2 md:left-8 top-1/2 -translate-y-1/2 text-white/70 hover:text-white p-4 z-50 transition-transform active:scale-95"
               >
                 <div className="bg-white/10 backdrop-blur-sm p-4 rounded-full border border-white/20"><ArrowLeftIcon /></div>
               </button>
               <button 
                  onClick={nextLightboxMedia}
                  className="absolute right-2 md:right-8 top-1/2 -translate-y-1/2 text-white/70 hover:text-white p-4 z-50 transition-transform active:scale-95"
               >
                  <div className="bg-white/10 backdrop-blur-sm p-4 rounded-full border border-white/20"><ArrowRightIcon /></div>
               </button>
             </>
           )}

           {/* Content */}
           <div className="relative w-full h-full p-4 md:p-12 flex items-center justify-center">
              {lightboxItems[lightboxIndex].type === 'video' ? (
                  <video 
                    src={lightboxItems[lightboxIndex].url} 
                    controls 
                    className="max-w-full max-h-full object-contain"
                  ></video>
              ) : (
                  <img 
                    src={lightboxItems[lightboxIndex].url} 
                    alt="Full screen view"
                    className="max-w-full max-h-full object-contain"
                  />
              )}
              
              {/* Counter Indicator */}
              {lightboxItems.length > 1 && (
                  <div className="absolute top-6 left-6 text-white/80 text-sm font-mono bg-black/50 px-3 py-1 rounded-full">
                      {lightboxIndex + 1} / {lightboxItems.length}
                  </div>
              )}

              {/* Caption */}
              {lightboxItems[lightboxIndex].caption && (
                  <div className="absolute bottom-10 left-0 w-full text-center pointer-events-none">
                    <span className="bg-black/60 backdrop-blur text-white px-6 py-3 rounded-full text-sm font-medium">
                        {lightboxItems[lightboxIndex].caption}
                    </span>
                  </div>
              )}
           </div>
        </div>
      )}

      {/* Cart Drawer */}
      <div className={`fixed inset-0 z-50 transition-visibility duration-300 ${isCartOpen ? 'visible' : 'invisible'}`}>
        <div 
            className={`absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300 ${isCartOpen ? 'opacity-100' : 'opacity-0'}`}
            onClick={() => setIsCartOpen(false)}
        ></div>
        <div className={`absolute top-0 right-0 w-full max-w-md h-full bg-white shadow-2xl transition-transform duration-300 transform flex flex-col ${isCartOpen ? 'translate-x-0' : 'translate-x-full'}`}>
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-white">
                <h2 className="font-serif text-xl uppercase tracking-wider">Ваш кошик</h2>
                <button onClick={() => setIsCartOpen(false)} className="hover:rotate-90 transition-transform duration-300"><XIcon /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {!cart || cart.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-gray-400">
                        <ShoppingBagIcon />
                        <p className="mt-4 text-sm uppercase tracking-wide">Кошик порожній</p>
                        <button onClick={() => setIsCartOpen(false)} className="mt-4 border border-black px-6 py-2 text-xs uppercase hover:bg-black hover:text-white transition">Продовжити покупки</button>
                    </div>
                ) : (
                    cart.map((item, idx) => (
                        <div key={item.cartId} className="flex gap-4 pb-6 border-b border-gray-50 last:border-0">
                            <div className="w-20 h-24 bg-gray-100 flex-shrink-0">
                                <img src={getImageUrl(item.images[0])} alt={item.title} className="w-full h-full object-cover"/>
                            </div>
                            <div className="flex-1 flex flex-col justify-between">
                                <div>
                                    <h4 className="font-serif text-sm uppercase mb-1">{item.title}</h4>
                                    <p className="text-xs text-gray-500">
                                        Розмір: {item.selectedSize}
                                        {item.selectedColor && ` · Колір: ${item.selectedColor}`}
                                    </p>
                                </div>
                                <div className="flex justify-between items-end">
                                    <span className="font-semibold text-sm">{item.price} UAH</span>
                                    <button 
                                        onClick={() => removeFromCart(idx)}
                                        className="text-[10px] uppercase text-gray-400 border-b border-gray-300 hover:text-red-500 hover:border-red-500 transition-colors"
                                    >
                                        Видалити
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {cart && cart.length > 0 && (
                <div className="p-6 bg-gray-50 border-t border-gray-100">
                     {!showOrderForm ? (
                         <>
                            <div className="flex justify-between mb-6 text-sm font-bold uppercase">
                                <span>Разом:</span>
                                <span>{cartTotal} UAH</span>
                            </div>
                             <div className="space-y-3">
                                <button 
                                    onClick={() => setShowOrderForm(true)}
                                    className="w-full bg-black text-white py-4 uppercase tracking-widest text-xs font-bold hover:bg-gray-800 transition-colors"
                                >
                                    Оформити замовлення
                                </button>
                                <button 
                                    onClick={() => setIsCartOpen(false)}
                                    className="w-full border border-gray-300 text-gray-600 py-3 uppercase tracking-widest text-xs font-bold hover:border-black hover:text-black transition-colors"
                                >
                                    Продовжити покупки
                                </button>
                             </div>
                         </>
                     ) : (
                         <div className="animate-fade-in-up">
                            {/* Order Form Inputs - Extended */}
                            <h3 className="font-serif mb-4 uppercase text-sm">Дані отримувача</h3>
                            <div className="space-y-4 mb-4">
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="relative">
                                        <input 
                                            type="text" 
                                            placeholder="Ім'я" 
                                            className={`w-full border-b py-2 text-base outline-none bg-transparent focus:border-black transition-colors ${formErrors.firstName ? 'border-red-500 placeholder-red-400' : 'border-gray-300'}`} 
                                            value={orderForm.firstName} 
                                            onChange={(e) => handleInputChange('firstName', e.target.value)}
                                        />
                                    </div>
                                    <div className="relative">
                                        <input 
                                            type="text" 
                                            placeholder="Прізвище" 
                                            className={`w-full border-b py-2 text-base outline-none bg-transparent focus:border-black transition-colors ${formErrors.lastName ? 'border-red-500 placeholder-red-400' : 'border-gray-300'}`} 
                                            value={orderForm.lastName} 
                                            onChange={(e) => handleInputChange('lastName', e.target.value)}
                                        />
                                    </div>
                                </div>
                                <input 
                                    type="tel" 
                                    placeholder="+380 (XX) XXX-XX-XX" 
                                    className={`w-full border-b py-2 text-base outline-none bg-transparent focus:border-black transition-colors ${formErrors.phone ? 'border-red-500 placeholder-red-400' : 'border-gray-300'}`} 
                                    value={orderForm.phone} 
                                    onChange={handlePhoneChange}
                                />
                                <div className="space-y-3 pt-2">
                                    <input 
                                        type="text" 
                                        placeholder="Місто / Населений пункт" 
                                        className={`w-full border-b py-2 text-base outline-none bg-transparent focus:border-black transition-colors ${formErrors.city ? 'border-red-500 placeholder-red-400' : 'border-gray-300'}`} 
                                        value={orderForm.city} 
                                        onChange={(e) => handleInputChange('city', e.target.value)}
                                    />
                                    <input 
                                        type="text" 
                                        placeholder="Відділення Нової Пошти або Поштомат НП" 
                                        className={`w-full border-b py-2 text-base outline-none bg-transparent focus:border-black transition-colors ${formErrors.branch ? 'border-red-500 placeholder-red-400' : 'border-gray-300'}`} 
                                        value={orderForm.branch} 
                                        onChange={(e) => handleInputChange('branch', e.target.value)}
                                    />
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => setShowOrderForm(false)} className="flex-1 border py-3 text-xs uppercase">Назад</button>
                                <button onClick={handleCheckout} className="flex-[2] bg-black text-white py-3 text-xs font-bold uppercase">Підтвердити</button>
                            </div>
                         </div>
                     )}
                </div>
            )}
        </div>
      </div>
      
    </div>
  );
}