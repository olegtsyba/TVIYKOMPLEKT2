import React, { useState, useEffect, useMemo, useRef } from 'react';
import { PRODUCTS, CATEGORIES, SIZE_CHARTS } from './constants';
import { Product, CartItem } from './types';
// Removed v9 modular imports as we are switching to v8 compat style due to environment issues
// import { collection, getDocs, query, orderBy } from 'firebase/firestore'; 
import { db } from './firebase';

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
const ArrowUpIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
);
const RulerIcon = () => (
   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12h20"></path><path d="M6 12v-2"></path><path d="M10 12v-2"></path><path d="M14 12v-2"></path><path d="M18 12v-2"></path></svg>
);

const TG_BOT_TOKEN = '7628860733:AAHrK-pL_aQ0HpJ1tB0O6uC-6C6QzO5e3i8';
const TG_CHAT_ID = '-4763943340';

export default function App() {
  // Data State
  const [allProducts, setAllProducts] = useState<Product[]>([]);
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
  const [orderForm, setOrderForm] = useState({ name: '', phone: '', city: '' });
  const [formErrors, setFormErrors] = useState({ name: false, phone: false, city: false });
  const [showOrderForm, setShowOrderForm] = useState(false);
  
  const [scrolled, setScrolled] = useState(false);
  
  // Modal specific states
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [showSizeTable, setShowSizeTable] = useState(false);
  const [showVideoAccordion, setShowVideoAccordion] = useState(false);
  const [showReviewsAccordion, setShowReviewsAccordion] = useState(false);
  const [sizeError, setSizeError] = useState(false);

  // References
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Fetch Data Effect
  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true);
        // 1. Fetch from Firestore (v8 syntax)
        const querySnapshot = await db.collection("products").orderBy("createdAt", "desc").get();
        
        const firebaseProducts: Product[] = querySnapshot.docs.map((doc: any) => {
          const data = doc.data();
          // Map Firestore loose data to Strict Product Type
          return {
            id: doc.id,
            title: data.title,
            price: Number(data.price),
            images: data.images || [],
            sizes: data.sizes || ["S", "M", "L"],
            colors: data.colors ? data.colors.map((c: any) => c.name || c) : [], // Handle complex colors object
            videoId: data.videoId || undefined,
            sizeCategory: data.sizeCategory || 'default',
            reviews: data.reviews || [],
            relatedColors: [], // Admin panel doesn't set this yet, can be computed later
          } as Product;
        });

        // 2. Merge with Static Products (Static at bottom, Newest Firestore at top)
        setAllProducts([...firebaseProducts, ...PRODUCTS]);
      } catch (error) {
        console.error("Error fetching products:", error);
        // Fallback to static only on error
        setAllProducts(PRODUCTS);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  // Effects
  useEffect(() => {
    // Load Cart from LocalStorage
    const savedCart = localStorage.getItem('myShopCart');
    if (savedCart) {
      try {
        setCart(JSON.parse(savedCart));
      } catch (e) {
        console.error("Failed to parse cart", e);
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
    localStorage.setItem('myShopCart', JSON.stringify(cart));
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
    }
  }, [selectedProduct]);

  // Focus input when search opens
  useEffect(() => {
    if (isSearchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isSearchOpen]);

  // Close search when clicking outside
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
    // Use allProducts state instead of constant
    return allProducts.filter(product => {
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
      if (videoId.length === 11) {
          return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
      }
      return videoId; 
  }

  // Robust Image Getter for Modal
  const getProductImages = (product: Product | null) => {
      if (!product) return [];
      // Prefer the new 'images' array. If empty, check for legacy 'image' property (fallback).
      // If still empty, return placeholder.
      if (product.images && product.images.length > 0) return product.images;
      // @ts-ignore - handling legacy field if it exists in data but not in type
      if (product.image) return [product.image];
      return ['https://via.placeholder.com/400x500?text=No+Image'];
  };

  // Cart Logic
  const addToCart = (product: Product, size: string) => {
    if (product.sizes.length > 0 && !size) {
      showToast("⚠️ Оберіть розмір!", "error");
      setSizeError(true);
      setTimeout(() => setSizeError(false), 600); // Clear error animation after it plays
      return;
    }
    const finalSize = size || "One Size";
    const newItem: CartItem = { ...product, selectedSize: finalSize, cartId: Date.now() };
    setCart([...cart, newItem]);
    showToast(`✅ ${product.title} додано!`);
    setIsCartOpen(true);
    setSelectedProduct(null); // Close modal if open
  };

  const removeFromCart = (index: number) => {
    const newCart = [...cart];
    newCart.splice(index, 1);
    setCart(newCart);
  };

  const cartTotal = cart.reduce((acc, item) => acc + item.price, 0);

  // --- Validation Logic ---

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Allow only letters (Cyrillic/Latin), hyphens, and spaces
    const val = e.target.value.replace(/[^a-zA-Zа-яА-ЯёЁіІїЇєЄґҐ\s-]/g, '');
    setOrderForm(prev => ({ ...prev, name: val }));
    // Clear error if user is typing
    if (formErrors.name) setFormErrors(prev => ({ ...prev, name: false }));
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value.replace(/\D/g, ''); // Remove non-digits

    // Smart Prefix Logic
    if (val.startsWith('0')) {
        val = '38' + val;
    } else if (val.startsWith('80')) {
        val = '3' + val;
    }
    
    // Ensure it always starts with 380 if there is any input
    if (val && !val.startsWith('380')) {
        val = '380' + val;
    }

    // Limit to 12 digits (380 XX XXX XX XX)
    val = val.substring(0, 12);

    // Apply Mask: +380 (XX) XXX-XX-XX
    let formatted = '';
    if (val.length > 0) formatted += '+' + val.substring(0, 3);
    if (val.length > 3) formatted += ' (' + val.substring(3, 5);
    if (val.length > 5) formatted += ') ' + val.substring(5, 8);
    if (val.length > 8) formatted += '-' + val.substring(8, 10);
    if (val.length > 10) formatted += '-' + val.substring(10, 12);

    setOrderForm(prev => ({ ...prev, phone: formatted }));
    if (formErrors.phone) setFormErrors(prev => ({ ...prev, phone: false }));
  };

  const handleCityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setOrderForm(prev => ({ ...prev, city: e.target.value }));
      if (formErrors.city) setFormErrors(prev => ({ ...prev, city: false }));
  }

  const handleCheckout = async () => {
    // 1. Strict Validation
    const cleanPhone = orderForm.phone.replace(/\D/g, '');
    
    const isNameValid = orderForm.name.trim().length >= 2;
    const isPhoneValid = cleanPhone.length === 12; // Must be exactly 12 digits: 380XXXXXXXXX
    const isCityValid = orderForm.city.trim().length > 0;

    if (!isNameValid || !isPhoneValid || !isCityValid) {
        setFormErrors({
            name: !isNameValid,
            phone: !isPhoneValid,
            city: !isCityValid
        });
        
        let errorMsg = "Перевірте дані!";
        if (!isNameValid) errorMsg = "Ім'я занадто коротке";
        else if (!isPhoneValid) errorMsg = "Невірний номер телефону";
        else if (!isCityValid) errorMsg = "Вкажіть місто";
        
        showToast(`❌ ${errorMsg}`, "error");
        return;
    }

    // 2. Prepare Data
    let message = `<b>📦 НОВЕ ЗАМОВЛЕННЯ!</b>\n\n👤 <b>Клієнт:</b> ${orderForm.name}\n📞 <b>Телефон:</b> ${orderForm.phone}\n🏙 <b>Адреса:</b> ${orderForm.city}\n\n🛒 <b>Товари:</b>\n`;
    cart.forEach((item, index) => {
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
        showToast("✅ Замовлення прийнято!");
        setCart([]);
        setOrderForm({ name: '', phone: '', city: '' });
        setFormErrors({ name: false, phone: false, city: false });
        setShowOrderForm(false);
        setIsCartOpen(false);
      } else {
        showToast("❌ Помилка відправки.", "error");
      }
    } catch (error) {
      console.error(error);
      showToast("❌ Помилка з'єднання.", "error");
    }
  };

  const switchColor = (newId: number | string) => {
      const newProduct = allProducts.find(p => p.id === newId);
      if (newProduct) {
          setSelectedProduct(newProduct);
          // Scroll to top of info section if needed, or just standard React re-render will handle data
      }
  };

  // Resolve Size Chart
  const activeSizeChart = useMemo(() => {
    if (!selectedProduct) return null;
    if (selectedProduct.sizeChart) return selectedProduct.sizeChart; // Product specific
    if (selectedProduct.sizeCategory && SIZE_CHARTS[selectedProduct.sizeCategory]) {
        return SIZE_CHARTS[selectedProduct.sizeCategory]; // Category based
    }
    return SIZE_CHARTS['default']; // Fallback
  }, [selectedProduct]);

  // Calculate Average Rating
  const averageRating = useMemo(() => {
    if (!selectedProduct || !selectedProduct.reviews || selectedProduct.reviews.length === 0) return 5;
    const total = selectedProduct.reviews.reduce((acc, r) => acc + r.rating, 0);
    return Math.round(total / selectedProduct.reviews.length);
  }, [selectedProduct]);

  return (
    <div className="min-h-screen flex flex-col font-sans">
      {/* Notifications - FIXED Z-INDEX to be above modal */}
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
              title={isSearchOpen ? "Закрити пошук" : "Пошук"}
            >
              {isSearchOpen ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              ) : (
                <SearchIcon />
              )}
            </button>
            {/* Search Dropdown */}
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
                    window.scrollTo({ top: 600, behavior: 'smooth' }); // Scroll to grid
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
            TVIYKOMPLEKT
          </div>

          {/* Cart Trigger */}
          <button 
            className={`p-2 relative transition-colors duration-300 hover:opacity-70 ${scrolled ? 'text-black' : 'text-white'}`}
            onClick={() => setIsCartOpen(true)}
          >
            <ShoppingBagIcon />
            {cart.length > 0 && (
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
            <img 
                src="https://images.unsplash.com/photo-1483985988355-763728e1935b?q=80&w=2070&auto=format&fit=crop" 
                alt="Hero Background" 
                className="w-full h-full object-cover opacity-80"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent"></div>
        </div>
        
        <div className="relative z-10 px-6 md:pl-24 max-w-2xl text-center md:text-left">
            <div className="backdrop-blur-md bg-white/10 p-8 md:p-12 border border-white/20 shadow-2xl">
                <span className="block text-xs md:text-sm tracking-[0.3em] text-white/90 mb-4 uppercase">Весна - Літо 2025</span>
                <h1 className="font-serif text-4xl md:text-6xl text-white font-bold mb-6 leading-tight">
                    NEW <br/> COLLECTION
                </h1>
                <p className="text-white/80 mb-8 text-sm md:text-base leading-relaxed">
                    Естетика. Комфорт. Впевненість. Одяг, який підкреслює твою індивідуальність.
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
                {displayedProducts.map(product => {
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
                                {/* Quick Add Overlay (Desktop) */}
                                <div className="absolute inset-x-0 bottom-0 bg-white/95 p-4 translate-y-full group-hover:translate-y-0 transition-transform duration-300 hidden md:flex flex-col gap-3 border-t border-gray-100">
                                    <button className="w-full bg-black text-white py-3 text-xs uppercase tracking-widest font-bold hover:bg-gray-800 transition-colors">
                                        Швидкий перегляд
                                    </button>
                                </div>
                            </div>
                            <h3 className="text-xs uppercase tracking-wide text-gray-900 truncate mb-1 pr-2">{product.title}</h3>
                            <p className="text-sm font-semibold text-gray-900">{product.price} UAH</p>
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
                <h3 className="font-serif text-2xl mb-6">TVIYKOMPLEKT</h3>
                <p className="text-gray-400 text-sm leading-relaxed mb-6">
                    Створюємо одяг, який підкреслює твою індивідуальність. Якість у кожному шві.
                </p>
                <div className="flex gap-4">
                    <a href="#" className="text-xs font-bold border-b border-white pb-1 hover:text-gray-300">INSTAGRAM</a>
                    <a href="#" className="text-xs font-bold border-b border-white pb-1 hover:text-gray-300">TIKTOK</a>
                </div>
            </div>
            
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
                    <button className="mt-4 border border-white text-white px-6 py-2 text-xs uppercase hover:bg-white hover:text-black transition-colors">
                        Зателефонувати
                    </button>
                </div>
            </div>

            <div>
                 <h4 className="font-bold text-sm uppercase tracking-widest mb-6">Newsletter</h4>
                 <p className="text-gray-400 text-xs mb-4">Отримуй інформацію про знижки першим.</p>
                 <div className="flex border-b border-gray-600 pb-2">
                    <input type="email" placeholder="Ваш Email" className="bg-transparent w-full outline-none text-sm placeholder-gray-500"/>
                    <button className="text-white hover:text-gray-300"><ArrowRightIcon /></button>
                 </div>
            </div>
        </div>
        <div className="text-center pt-8 text-xs text-gray-600">
            &copy; 2025 TVIYKOMPLEKT. Всі права захищено.
        </div>
      </footer>

      {/* Product Modal */}
      {selectedProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setSelectedProduct(null)}></div>
            <div className="relative bg-white w-full max-w-6xl h-[95vh] rounded-sm overflow-hidden flex flex-col shadow-2xl animate-fade-in-up">
                
                {/* Close Button */}
                <button 
                    onClick={() => setSelectedProduct(null)}
                    className="absolute top-4 right-4 z-50 p-2 bg-white/80 rounded-full hover:bg-white shadow-sm"
                >
                    <XIcon />
                </button>

                {/* Modal Content Scrollable Area */}
                <div className="flex-1 overflow-y-auto">
                    
                    {/* Main Layout Grid */}
                    <div className="flex flex-col md:flex-row h-full">
                        
                        {/* Left: Gallery */}
                        <div className="w-full md:w-1/2 bg-gray-50 p-4 md:p-8 flex flex-col h-[50vh] md:h-auto">
                           {(() => {
                               const images = getProductImages(selectedProduct);
                               return (
                                   <>
                                       <div className="flex-1 relative overflow-hidden bg-white shadow-sm aspect-[4/5] md:aspect-auto">
                                           <img 
                                                src={getImageUrl(images[currentImageIndex])} 
                                                alt={selectedProduct.title} 
                                                className="w-full h-full object-cover object-top"
                                            />
                                            {images.length > 1 && (
                                                <>
                                                    <button 
                                                        className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/70 p-2 hover:bg-white rounded-full shadow-sm transition-all"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setCurrentImageIndex(prev => prev === 0 ? images.length - 1 : prev - 1);
                                                        }}
                                                    >
                                                        <ArrowRightIcon />
                                                    </button>
                                                    <button 
                                                        className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/70 p-2 hover:bg-white rounded-full shadow-sm transition-all"
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
                                       {images.length > 1 && (
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

                        {/* Right: Info */}
                        <div className="w-full md:w-1/2 p-6 md:p-10 flex flex-col bg-white overflow-y-auto">
                            <div className="mb-6">
                                <h2 className="font-serif text-2xl md:text-3xl mb-1 leading-tight">{selectedProduct.title}</h2>
                                {/* Rating Summary */}
                                <div className="flex items-center gap-2 mb-3">
                                    <div className="flex text-yellow-500 text-sm">
                                        {'★'.repeat(averageRating)}{'☆'.repeat(5-averageRating)}
                                    </div>
                                    <span className="text-xs text-gray-500 font-medium">({selectedProduct.reviews?.length || 0} відгуків)</span>
                                </div>
                                <p className="text-xl font-bold">{selectedProduct.price} UAH</p>
                            </div>

                            <div className="text-gray-600 text-sm leading-relaxed border-t border-gray-100 py-6 mb-6">
                                <p>Опис: Тканина преміум якості, що дихає та не просвічує. Ідеально підходить для інтенсивних тренувань та повсякденного стилю. Анатомічний крій підкреслює фігуру.</p>
                            </div>

                            {/* Color Selection (New) */}
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
                                                        {activeSizeChart.columns.map((col, i) => (
                                                            <th key={i} className="py-2 px-2 font-medium">{col}</th>
                                                        ))}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {activeSizeChart.rows.map((row, i) => (
                                                        <tr key={i} className="border-b border-gray-100 last:border-0 hover:bg-gray-100/50">
                                                            {row.map((cell, j) => (
                                                                <td key={j} className="py-2 px-2 text-gray-700 font-medium">{cell}</td>
                                                            ))}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    ) : (
                                        <p className="text-xs text-red-500">Таблиця розмірів відсутня.</p>
                                    )}
                                </div>

                                <div className={`flex flex-wrap gap-3 p-2 rounded transition-all duration-300 ${sizeError ? 'input-error bg-red-50' : 'border border-transparent'}`}>
                                    {selectedProduct.sizes.length > 0 ? selectedProduct.sizes.map(size => (
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

                            {/* Video Accordion */}
                            {selectedProduct.videoId && (
                                <div className="mb-4">
                                    <button
                                        onClick={() => setShowVideoAccordion(!showVideoAccordion)}
                                        className="flex items-center gap-2 text-xs uppercase font-bold tracking-wider hover:text-gray-600 transition-colors w-full py-2 text-left"
                                        type="button"
                                    >
                                        <span className={`inline-block transition-transform duration-300 ${showVideoAccordion ? 'rotate-90' : 'rotate-0'}`}>
                                            ▶
                                        </span>
                                        {showVideoAccordion ? 'Сховати відеоогляд' : 'Дивитись відеоогляд'}
                                    </button>
                                    
                                    <div className={`overflow-hidden transition-all duration-500 ease-in-out ${showVideoAccordion ? 'max-h-[300px] opacity-100 mt-2' : 'max-h-0 opacity-0'}`}>
                                        <div className="w-full aspect-video bg-black rounded shadow-inner">
                                            {showVideoAccordion && (
                                                 <iframe 
                                                    width="100%" 
                                                    height="100%" 
                                                    src={getEmbedUrl(selectedProduct.videoId)} 
                                                    title="Video Review" 
                                                    frameBorder="0" 
                                                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                                                    allowFullScreen
                                                ></iframe>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Buy Button */}
                            <button 
                                onClick={() => addToCart(selectedProduct, selectedSizeForModal)}
                                className="w-full bg-black text-white py-4 uppercase tracking-widest text-sm font-bold hover:bg-gray-800 transition-colors shadow-lg mb-4"
                            >
                                Додати в кошик
                            </button>

                            {/* Reviews Accordion */}
                            <div className="border-t border-gray-100 pt-2">
                                <button
                                    onClick={() => setShowReviewsAccordion(!showReviewsAccordion)}
                                    className="flex justify-between items-center w-full py-3 text-xs uppercase font-bold tracking-wider hover:text-gray-600 transition-colors"
                                >
                                    <span>⭐ Відгуки клієнтів ({selectedProduct.reviews?.length || 0})</span>
                                    <span className={`inline-block transition-transform duration-300 ${showReviewsAccordion ? 'rotate-180' : 'rotate-0'}`}>
                                        ▼
                                    </span>
                                </button>

                                <div className={`overflow-hidden transition-all duration-500 ease-in-out ${showReviewsAccordion ? 'max-h-[400px] opacity-100' : 'max-h-0 opacity-0'}`}>
                                    <div className="space-y-4 py-2 overflow-y-auto max-h-[400px] pr-2 custom-scrollbar">
                                        {selectedProduct.reviews && selectedProduct.reviews.length > 0 ? (
                                            selectedProduct.reviews.map((rev, idx) => (
                                                <div key={idx} className="bg-gray-50 p-3 rounded border border-gray-100">
                                                    <div className="flex justify-between items-start mb-2">
                                                        <span className="text-xs font-bold">{rev.user}</span>
                                                        <div className="flex text-yellow-500 text-[10px]">
                                                            {'★'.repeat(rev.rating)}{'☆'.repeat(5-rev.rating)}
                                                        </div>
                                                    </div>
                                                    <p className="text-xs text-gray-600 leading-relaxed mb-2">{rev.text}</p>
                                                    
                                                    {rev.url && (
                                                        <div className="w-16 h-16 rounded overflow-hidden border border-gray-200 cursor-pointer hover:opacity-90 transition-opacity" onClick={() => window.open(rev.url, '_blank')}>
                                                            {rev.type === 'video' ? (
                                                                <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                                                                    <div className="w-0 h-0 border-l-[4px] border-l-white border-y-[3px] border-y-transparent ml-0.5"></div>
                                                                </div>
                                                            ) : (
                                                                <img src={rev.url} alt="Review" className="w-full h-full object-cover" />
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            ))
                                        ) : (
                                            <p className="text-xs text-gray-400 italic text-center py-2">Ще немає відгуків.</p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
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
                {cart.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-gray-400">
                        <ShoppingBagIcon />
                        <p className="mt-4 text-sm uppercase tracking-wide">Кошик порожній</p>
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

            {cart.length > 0 && (
                <div className="p-6 bg-gray-50 border-t border-gray-100">
                     {!showOrderForm ? (
                         <>
                            <div className="flex justify-between mb-6 text-sm font-bold uppercase">
                                <span>Разом:</span>
                                <span>{cartTotal} UAH</span>
                            </div>
                            <button 
                                onClick={() => setShowOrderForm(true)}
                                className="w-full bg-black text-white py-4 uppercase tracking-widest text-xs font-bold hover:bg-gray-800 transition-colors"
                            >
                                Оформити замовлення
                            </button>
                         </>
                     ) : (
                         <div className="animate-fade-in-up">
                            <h3 className="font-serif mb-4 uppercase text-sm">Оформлення</h3>
                            <div className="space-y-4 mb-4">
                                <div>
                                    <input 
                                        id="order-name"
                                        type="text" 
                                        placeholder="Ваше Ім'я" 
                                        className={`w-full bg-transparent border-b py-2 text-sm outline-none transition-all ${formErrors.name ? 'input-error border-red-500 text-red-500 placeholder-red-300' : 'border-gray-300 focus:border-black'}`}
                                        value={orderForm.name}
                                        onChange={handleNameChange}
                                        autoComplete="name"
                                    />
                                </div>
                                <div>
                                    <input 
                                        id="order-phone"
                                        type="tel" 
                                        placeholder="+380 (XX) XXX-XX-XX" 
                                        className={`w-full bg-transparent border-b py-2 text-sm outline-none transition-all ${formErrors.phone ? 'input-error border-red-500 text-red-500 placeholder-red-300' : 'border-gray-300 focus:border-black'}`}
                                        value={orderForm.phone}
                                        onChange={handlePhoneChange}
                                        maxLength={19}
                                        autoComplete="tel"
                                    />
                                </div>
                                <div>
                                    <input 
                                        type="text" 
                                        placeholder="Місто та відділення НП" 
                                        className={`w-full bg-transparent border-b py-2 text-sm outline-none transition-all ${formErrors.city ? 'input-error border-red-500 text-red-500 placeholder-red-300' : 'border-gray-300 focus:border-black'}`}
                                        value={orderForm.city}
                                        onChange={handleCityChange}
                                    />
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <button 
                                    onClick={() => setShowOrderForm(false)}
                                    className="flex-1 border border-gray-300 py-3 uppercase text-xs hover:bg-gray-200"
                                >
                                    Назад
                                </button>
                                <button 
                                    onClick={handleCheckout}
                                    className="flex-[2] bg-black text-white py-3 uppercase text-xs font-bold hover:bg-gray-800"
                                >
                                    Підтвердити
                                </button>
                            </div>
                         </div>
                     )}
                </div>
            )}
        </div>
      </div>

      {/* Scroll Top Button */}
      <button 
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        className={`fixed bottom-8 right-8 z-30 p-3 bg-white border border-black hover:bg-black hover:text-white transition-all duration-300 shadow-lg ${showScrollTop ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10 pointer-events-none'}`}
      >
        <ArrowUpIcon />
      </button>

    </div>
  );
}