import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { PRODUCTS, CATEGORIES, SIZE_CHARTS } from './constants';
import { Product, CartItem, SiteSettings, Review, SizeChartRow } from './types';
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { fetchAllKeycrmProducts, fetchOffersForProduct, mapKeycrmProduct, deriveVariants, getMinOfferPrice } from './services/keycrm';
import { fetchActivePromotions, applyPromotion } from './services/promotions';

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
const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={filled ? "text-yellow-500" : "text-gray-300"}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
);
const ZoomInIcon = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-md"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
);

const TG_BOT_TOKEN = '7628860733:AAHrK-pL_aQ0HpJ1tB0O6uC-6C6QzO5e3i8';
const TG_CHAT_ID = '-4763943340';

const DEFAULT_SETTINGS: SiteSettings = {
  heroTitle: "NEW\nCOLLECTION",
  heroSubtitle: "Весна - Літо 2025",
  heroBackgroundUrl: "https://images.unsplash.com/photo-1483985988355-763728e1935b?q=80&w=2070&auto=format&fit=crop",
  logoText: "TVIYKOMPLEKT",
  heroDescription: "Естетика. Комфорт. Впевненість. Одяг, який підкреслює твою індивідуальність."
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
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedSizeForModal, setSelectedSizeForModal] = useState<string>('');
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
  const [showVideoAccordion, setShowVideoAccordion] = useState(false);
  const [showReviewsAccordion, setShowReviewsAccordion] = useState(false);
  const [sizeError, setSizeError] = useState(false);

  // Lightbox State
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxItems, setLightboxItems] = useState<LightboxItem[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  // References
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const variantsLoadedRef = useRef<Set<string>>(new Set());

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
          const [kcProducts, promotions] = await Promise.all([
            fetchAllKeycrmProducts(),
            fetchActivePromotions(),
          ]);

          const products = kcProducts
            .slice()
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .map(mapKeycrmProduct);

          // Render the grid immediately with what we have. A handful of KeyCRM
          // products report min_price=0 on the list endpoint even though their
          // offers carry real prices — those get patched in the background
          // below so the first paint isn't blocked on extra requests.
          setAllProducts(products.map(p => applyPromotion(p, promotions.get(String(p.id)))));

          const zeroPriceProducts = products.filter(p => p.price === 0);
          if (zeroPriceProducts.length > 0) {
            void Promise.all(zeroPriceProducts.map(async (p) => {
              try {
                const offers = await fetchOffersForProduct(p.id);
                const minPrice = getMinOfferPrice(offers);
                const { sizes, colors } = deriveVariants(offers);
                variantsLoadedRef.current.add(String(p.id));
                if (minPrice === null) return;

                setAllProducts(prev => prev.map(item => (
                  String(item.id) === String(p.id)
                    ? applyPromotion({ ...item, price: minPrice, sizes, colors }, promotions.get(String(p.id)))
                    : item
                )));
              } catch (err) {
                console.warn("Could not resolve price from offers for product", p.id, err);
              }
            }));
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
      setShowVideoAccordion(false);
      setShowReviewsAccordion(false);
      setSelectedSizeForModal('');
      setSizeError(false);
      setIsLightboxOpen(false);
      setLightboxItems([]);
    }
  }, [selectedProduct]);

  // Lazily load sizes/colors (KeyCRM offers) the first time a product is opened
  useEffect(() => {
    if (!selectedProduct) return;
    const productKey = String(selectedProduct.id);
    if (variantsLoadedRef.current.has(productKey)) return;

    let cancelled = false;
    (async () => {
      try {
        const offers = await fetchOffersForProduct(selectedProduct.id);
        const { sizes, colors } = deriveVariants(offers);
        variantsLoadedRef.current.add(productKey);
        if (cancelled) return;

        setAllProducts(prev => prev.map(p => String(p.id) === productKey ? { ...p, sizes, colors } : p));
        setSelectedProduct(prev => prev && String(prev.id) === productKey ? { ...prev, sizes, colors } : prev);
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
  const filteredProducts = useMemo(() => {
    return (allProducts || []).filter(product => {
      const matchCategory = activeCategory === 'all' || product.title.toLowerCase().includes(activeCategory.toLowerCase());
      const matchSearch = product.title.toLowerCase().includes(searchQuery.toLowerCase());
      return matchCategory && matchSearch;
    });
  }, [activeCategory, searchQuery, allProducts]);

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
  const addToCart = (product: Product, size: string) => {
    if (product.sizes && product.sizes.length > 0 && !size) {
      showToast("⚠️ Оберіть розмір!", "error");
      setSizeError(true);
      setTimeout(() => setSizeError(false), 600); 
      return;
    }
    const finalSize = size || "One Size";
    const newItem: CartItem = { ...product, selectedSize: finalSize, cartId: Date.now() };
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

    let message = `<b>📦 НОВЕ ЗАМОВЛЕННЯ!</b>\n\n`;
    message += `👤 <b>Клієнт:</b> ${orderForm.firstName} ${orderForm.lastName}\n`;
    message += `📞 <b>Телефон:</b> ${orderForm.phone}\n`;
    message += `🏙 <b>Місто:</b> ${orderForm.city}\n`;
    message += `🚚 <b>Відділення/Поштомат НП:</b> ${orderForm.branch}\n\n`;
    message += `🛒 <b>Товари:</b>\n`;
    
    (cart || []).forEach((item, index) => {
        message += `${index + 1}. ${item.title} (${item.selectedSize}) - ${item.price} грн\n`;
    });
    message += `\n💰 <b>Разом до сплати:</b> ${cartTotal} грн`;

    try {
      const response = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          parse_mode: 'html',
          text: message
        })
      });

      if (response.ok) {
        showToast("✅ Замовлення прийнято! Менеджер зв'яжеться з вами.");
        setCart([]);
        setOrderForm({ firstName: '', lastName: '', phone: '', city: '', branch: '' });
        setShowOrderForm(false);
        setIsCartOpen(false);
      } else {
        showToast("❌ Помилка відправки.", "error");
      }
    } catch (error) {
      showToast("❌ Помилка з'єднання.", "error");
    }
  };

  const switchColor = (newId: number | string) => {
      const newProduct = allProducts.find(p => p.id === newId);
      if (newProduct) setSelectedProduct(newProduct);
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
                  className="w-full p-2 text-sm border-b border-gray-200 outline-none focus:border-black transition-colors bg-transparent"
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
            <img 
                src={siteSettings.heroBackgroundUrl || DEFAULT_SETTINGS.heroBackgroundUrl} 
                alt="Hero Background" 
                className="w-full h-full object-cover opacity-80"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent"></div>
        </div>
        
        <div className="relative z-10 px-6 md:pl-24 max-w-2xl text-center md:text-left">
            <div className="backdrop-blur-md bg-white/10 p-8 md:p-12 border border-white/20 shadow-2xl">
                {/* STATIC CLASSES, DYNAMIC CONTENT */}
                <span className="block text-xs md:text-sm tracking-[0.3em] text-white/90 mb-4 uppercase">
                    {siteSettings.heroSubtitle || "Весна - Літо 2025"}
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
        <div className="sticky top-[70px] z-30 bg-white/90 backdrop-blur-sm py-4 mb-8 border-b border-gray-100 overflow-x-auto no-scrollbar">
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
                                {product.oldPrice && product.oldPrice > product.price && (
                                    <span className="text-xs text-gray-400 line-through">{product.oldPrice} UAH</span>
                                )}
                                <span className={`text-sm font-semibold ${product.oldPrice ? 'text-red-600' : 'text-gray-900'}`}>{product.price} UAH</span>
                            </div>
                        </div>
                    );
                })}
            </div>
        ) : (
            <div className="text-center py-20 text-gray-400">
                <p>Товарів не знайдено :(</p>
                <button 
                    onClick={() => { setSearchQuery(''); setActiveCategory('all'); }}
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

      </main>

      {/* Footer */}
      <footer className="bg-black text-white pt-16 pb-8 px-6 mt-12">
        <div className="container mx-auto grid grid-cols-1 md:grid-cols-4 gap-12 border-b border-gray-800 pb-12">
            <div>
                <h3 className="font-serif text-2xl mb-6">{siteSettings.logoText}</h3>
                <p className="text-gray-400 text-sm leading-relaxed mb-6">
                    Створюємо одяг, який підкреслює твою індивідуальність. Якість у кожному шві.
                </p>
            </div>
            {/* Footer Links (Static) */}
            <div>
                <h4 className="font-bold text-sm uppercase tracking-widest mb-6">Клієнтам</h4>
                <ul className="space-y-3 text-sm text-gray-400">
                    <li><a href="#" className="hover:text-white transition-colors">Доставка та оплата</a></li>
                    <li><a href="#" className="hover:text-white transition-colors">Обмін та повернення</a></li>
                    <li><a href="#" className="hover:text-white transition-colors">Таблиця розмірів</a></li>
                </ul>
            </div>
            <div>
                <h4 className="font-bold text-sm uppercase tracking-widest mb-6">Контакти</h4>
                <div className="text-sm text-gray-400 space-y-2">
                    <p>+38 (097) 000-00-00</p>
                    <p>mon-fri: 10:00 - 19:00</p>
                    <p>myshop@gmail.com</p>
                </div>
            </div>
            <div>
                 <h4 className="font-bold text-sm uppercase tracking-widest mb-6">Newsletter</h4>
                 <div className="flex border-b border-gray-600 pb-2">
                    <input type="email" placeholder="Ваш Email" className="bg-transparent w-full outline-none text-sm placeholder-gray-500"/>
                    <button className="text-white hover:text-gray-300"><ArrowRightIcon /></button>
                 </div>
            </div>
        </div>
        <div className="text-center pt-8 text-xs text-gray-600">
            &copy; 2025 {siteSettings.logoText}. Всі права захищено.
        </div>
      </footer>

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
                    <div className="flex flex-col md:flex-row h-full">
                        {/* Gallery */}
                        <div className="w-full md:w-1/2 bg-gray-50 p-4 md:p-8 flex flex-col h-[50vh] md:h-auto">
                           {(() => {
                               const images = getProductImages(selectedProduct);
                               // Prepare image objects for the lightbox
                               const productLightboxItems: LightboxItem[] = images.map(url => ({ type: 'image', url }));

                               return (
                                   <>
                                       <div 
                                            className="flex-1 relative overflow-hidden bg-white shadow-sm aspect-[4/5] md:aspect-auto cursor-zoom-in group"
                                            onClick={() => openLightbox(productLightboxItems, currentImageIndex)}
                                       >
                                            {images && images.length > 0 && (
                                                <>
                                                    <img 
                                                        src={getImageUrl(images[currentImageIndex] || images[0])} 
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
                        <div className="w-full md:w-1/2 p-6 md:p-10 flex flex-col bg-white overflow-y-auto">
                            <div className="mb-6">
                                <h2 className="font-serif text-2xl md:text-3xl mb-1 leading-tight">{selectedProduct.title}</h2>
                                <div className="flex items-center gap-2 mb-3">
                                    <div className="flex text-yellow-500 text-sm">
                                        {'★'.repeat(averageRating)}{'☆'.repeat(5-averageRating)}
                                    </div>
                                    <span className="text-xs text-gray-500 font-medium">({selectedProduct.reviews?.length || 0} відгуків)</span>
                                </div>
                                <div className="flex items-end gap-3">
                                     {selectedProduct.oldPrice && selectedProduct.oldPrice > selectedProduct.price && (
                                        <span className="text-lg text-gray-400 line-through">{selectedProduct.oldPrice} UAH</span>
                                     )}
                                    <p className={`text-xl font-bold ${selectedProduct.oldPrice ? 'text-red-600' : 'text-black'}`}>{selectedProduct.price} UAH</p>
                                    {selectedProduct.oldPrice && selectedProduct.oldPrice > selectedProduct.price && (
                                        <span className="bg-red-600 text-white text-[10px] font-bold px-2 py-1 uppercase tracking-widest">
                                            {selectedProduct.badgeText || 'SALE'}
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div className="text-gray-600 text-sm leading-relaxed border-t border-gray-100 py-6 mb-6">
                                <p>Опис: Тканина преміум якості, що дихає та не просвічує. Ідеально підходить для інтенсивних тренувань та повсякденного стилю. Анатомічний крій підкреслює фігуру.</p>
                            </div>

                            {/* Color Selection */}
                            {selectedProduct.relatedColors && selectedProduct.relatedColors.length > 0 && (
                                <div className="mb-6">
                                    <p className="text-xs uppercase font-bold tracking-wider mb-2">Оберіть колір: <span className="text-gray-500 font-normal">{selectedProduct.relatedColors.find(c => c.id === selectedProduct.id)?.name}</span></p>
                                    <div className="flex gap-3">
                                        {selectedProduct.relatedColors.map(color => (
                                            <button
                                                key={color.id}
                                                onClick={() => switchColor(color.id)}
                                                className={`w-8 h-8 rounded-full border border-gray-200 transition-all duration-200 ${
                                                    selectedProduct.id === color.id 
                                                    ? 'ring-2 ring-offset-2 ring-black scale-110 shadow-sm' 
                                                    : 'hover:scale-110 hover:shadow-sm'
                                                }`}
                                                style={{ backgroundColor: color.colorCode }}
                                                title={color.name}
                                                aria-label={color.name}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Sizes & Chart */}
                            <div className="mb-6">
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
                                    {selectedProduct.sizes && selectedProduct.sizes.length > 0 ? selectedProduct.sizes.map(size => (
                                        <button
                                            key={size}
                                            onClick={() => {
                                                setSelectedSizeForModal(size);
                                                setSizeError(false);
                                            }}
                                            className={`w-12 h-12 flex items-center justify-center border text-sm transition-all duration-200 ${
                                                selectedSizeForModal === size 
                                                ? 'border-black bg-black text-white shadow-md transform scale-105' 
                                                : 'border-gray-200 hover:border-black text-gray-700'
                                            }`}
                                        >
                                            {size}
                                        </button>
                                    )) : (
                                        <span className="text-sm text-gray-500 italic">Універсальний розмір</span>
                                    )}
                                </div>
                            </div>

                            {/* Buy Button */}
                            <button 
                                onClick={() => addToCart(selectedProduct, selectedSizeForModal)}
                                className="w-full bg-black text-white py-4 uppercase tracking-widest text-sm font-bold hover:bg-gray-800 transition-colors shadow-lg mb-6"
                            >
                                Додати в кошик
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
                                <div className={`overflow-hidden transition-all duration-500 ease-in-out ${showVideoAccordion ? 'max-h-96 opacity-100 pb-6' : 'max-h-0 opacity-0'}`}>
                                   <div className="aspect-video bg-black rounded-sm overflow-hidden shadow-lg">
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
                                                 <span className="font-bold text-sm">{review.user}</span>
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
                                    <p className="text-xs text-gray-500">Розмір: {item.selectedSize}</p>
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
                                            className={`w-full border-b py-2 text-sm outline-none bg-transparent ${formErrors.firstName ? 'border-red-500 placeholder-red-400' : 'border-gray-300'}`} 
                                            value={orderForm.firstName} 
                                            onChange={(e) => handleInputChange('firstName', e.target.value)}
                                        />
                                    </div>
                                    <div className="relative">
                                        <input 
                                            type="text" 
                                            placeholder="Прізвище" 
                                            className={`w-full border-b py-2 text-sm outline-none bg-transparent ${formErrors.lastName ? 'border-red-500 placeholder-red-400' : 'border-gray-300'}`} 
                                            value={orderForm.lastName} 
                                            onChange={(e) => handleInputChange('lastName', e.target.value)}
                                        />
                                    </div>
                                </div>
                                <input 
                                    type="tel" 
                                    placeholder="+380 (XX) XXX-XX-XX" 
                                    className={`w-full border-b py-2 text-sm outline-none bg-transparent ${formErrors.phone ? 'border-red-500 placeholder-red-400' : 'border-gray-300'}`} 
                                    value={orderForm.phone} 
                                    onChange={handlePhoneChange}
                                />
                                <div className="space-y-3 pt-2">
                                    <input 
                                        type="text" 
                                        placeholder="Місто / Населений пункт" 
                                        className={`w-full border-b py-2 text-sm outline-none bg-transparent ${formErrors.city ? 'border-red-500 placeholder-red-400' : 'border-gray-300'}`} 
                                        value={orderForm.city} 
                                        onChange={(e) => handleInputChange('city', e.target.value)}
                                    />
                                    <input 
                                        type="text" 
                                        placeholder="Відділення Нової Пошти або Поштомат НП" 
                                        className={`w-full border-b py-2 text-sm outline-none bg-transparent ${formErrors.branch ? 'border-red-500 placeholder-red-400' : 'border-gray-300'}`} 
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