'use client';

import React, { useState, useEffect, useSyncExternalStore, useRef, useMemo } from 'react';
import Image from 'next/image';
import AdminPortal from '@/components/AdminPortal';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { 
  signInWithEmail, 
  signUpWithEmail, 
  signOutUser, 
  signInWithOAuth, 
  resetPassword,
  fetchUserProfile,
  getCurrentSession 
} from '@/lib/supabaseAuth';
import { 
  getProductsFromDb, 
  getCategoriesFromDb,
  saveContactMessageToDb, 
  syncCartWithDb
} from '@/lib/supabaseDb';
import { ProductItem } from '@/lib/types';
import { formatMoney } from '@/lib/utils';
import { 
  getStoreSettings, 
  StoreSettings, 
  DEFAULT_STORE_SETTINGS, 
  DEFAULT_HOT_DEALS,
  subscribeStoreSettings,
  getStoreSettingsSnapshot,
  getStoreSettingsServerSnapshot
} from '@/lib/storeSettings';
import { MobileDrawer } from '@/components/MobileDrawer';
import { SettingsView } from '@/components/SettingsView';
import { AccountProfileView } from '@/components/AccountProfileView';
import { TrackOrderView } from '@/components/TrackOrderView';
import { CategoriesView, FAQsView, ShippingReturnsView, AboutUsView } from '@/components/InfoViews';
import { DrumPalaceLogo } from '@/components/DrumPalaceLogo';
import { SonusBanner } from '@/components/SonusBanner';
import { 
  CurrencyCode, 
  subscribeCurrency, 
  getCurrencySnapshot, 
  getCurrencyServerSnapshot 
} from '@/lib/currency';
import { Menu, Heart, ShoppingCart, User, Shield, Search, Flame, ChevronLeft, ChevronRight, Sparkles, X } from 'lucide-react';

interface Product {
  id: string;
  name: string;
  cat: string;
  price: number;
  desc: string;
  image: string;
  images?: string[];
}

interface CartItem {
  id: string;
  qty: number;
}

interface CategoryInfo {
  id: string;
  name: string;
  sub: string;
  image: string;
}

const PHOTOS = {
  drums: 'https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=700&q=85',
  guitars: 'https://images.unsplash.com/photo-1525201548942-d8732f6617a0?auto=format&fit=crop&w=700&q=85',
  keyboards: 'https://images.unsplash.com/photo-1520523839897-bd0b52f945a0?auto=format&fit=crop&w=700&q=85',
  lighting: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=700&q=85',
  speakers: 'https://images.unsplash.com/photo-1545454675-3531b543be5d?auto=format&fit=crop&w=700&q=85',
  mixers: 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=700&q=85',
  mic: 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=700&q=85'
};

const themeListeners = new Set<() => void>();
const subscribeTheme = (callback: () => void) => {
  themeListeners.add(callback);
  return () => {
    themeListeners.delete(callback);
  };
};

const getThemeSnapshot = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem('drum-palace-theme') === 'dark';
  } catch {
    return false;
  }
};

const getThemeServerSnapshot = (): boolean => false;

export type AppRoute = 
  | 'home' 
  | 'shop' 
  | 'product' 
  | 'cart' 
  | 'checkout' 
  | 'login' 
  | 'register' 
  | 'account'
  | 'profile'
  | 'contact' 
  | 'wishlist'
  | 'settings'
  | 'track-order'
  | 'categories'
  | 'faqs'
  | 'shipping'
  | 'about'
  | 'orders';

export default function DrumPalaceApp() {
  const [route, setRoute] = useState<AppRoute>('home');
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const currency = useSyncExternalStore(subscribeCurrency, getCurrencySnapshot, getCurrencyServerSnapshot);
  const storeSettings = useSyncExternalStore(subscribeStoreSettings, getStoreSettingsSnapshot, getStoreSettingsServerSnapshot);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoadingProducts, setIsLoadingProducts] = useState<boolean>(true);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [wish, setWish] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeProductId, setActiveProductId] = useState<string>('');
  const [selectedImageIndex, setSelectedImageIndex] = useState<number>(0);
  const [detailQty, setDetailQty] = useState<number>(1);
  const [paymentMethod, setPaymentMethod] = useState<'momo' | 'card' | 'cod'>('momo');
  const [momoPhone, setMomoPhone] = useState<string>('');
  const [isProcessingPayment, setIsProcessingPayment] = useState<boolean>(false);
  const isDarkMode = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [showAdminPortal, setShowAdminPortal] = useState<boolean>(false);
  const hotDealsScrollRef = useRef<HTMLDivElement | null>(null);

  // Auth States
  const [currentUser, setCurrentUser] = useState<{ id?: string; email: string; name?: string; role?: string; phone?: string } | null>(null);
  const [pendingCheckout, setPendingCheckout] = useState<boolean>(false);
  const [checkoutName, setCheckoutName] = useState<string>('');
  const [checkoutEmail, setCheckoutEmail] = useState<string>('');
  const [checkoutPhone, setCheckoutPhone] = useState<string>('');
  const [checkoutAddress, setCheckoutAddress] = useState<string>('');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');
  const [regAgree, setRegAgree] = useState(false);
  const [regStatus, setRegStatus] = useState('');

  // Contact Form States
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactTopic, setContactTopic] = useState('');
  const [contactMessage, setContactMessage] = useState('');
  const [contactStatus, setContactStatus] = useState('');

  // Load dynamic products and categories from Supabase database
  const loadDbProducts = async () => {
    try {
      const [dbProducts, dbCategories] = await Promise.all([
        getProductsFromDb(),
        getCategoriesFromDb(),
      ]);

      if (dbCategories && dbCategories.length > 0) {
        setCategories(
          dbCategories.map((c) => {
            const slug = (c.slug || c.name || '').toLowerCase();
            let img = PHOTOS.drums;
            if (slug.includes('drum')) img = PHOTOS.drums;
            else if (slug.includes('guitar') || slug.includes('bass')) img = PHOTOS.guitars;
            else if (slug.includes('key') || slug.includes('piano') || slug.includes('synth')) img = PHOTOS.keyboards;
            else if (slug.includes('light')) img = PHOTOS.lighting;
            else if (slug.includes('speak') || slug.includes('pa')) img = PHOTOS.speakers;
            else if (slug.includes('mix') || slug.includes('audio') || slug.includes('mic')) img = PHOTOS.mixers;

            return {
              id: c.slug || c.id,
              name: c.name,
              sub: c.description || `${c.name} Gear`,
              image: c.image || img,
            };
          })
        );
      }

      if (dbProducts && dbProducts.length > 0) {
        const mapped: Product[] = dbProducts.map((p) => {
          let catKey = 'mixers';
          const c = (p.category || '').toLowerCase();
          if (c.includes('drum')) catKey = 'drums';
          else if (c.includes('guitar') || c.includes('bass')) catKey = 'guitars';
          else if (c.includes('key') || c.includes('piano') || c.includes('synth')) catKey = 'keyboards';
          else if (c.includes('light')) catKey = 'lighting';
          else if (c.includes('speak') || c.includes('pa')) catKey = 'speakers';
          else if (c.includes('mix') || c.includes('audio') || c.includes('mic')) catKey = 'mixers';

          return {
            id: p.id,
            name: p.name,
            cat: catKey,
            price: p.price,
            desc: p.description || p.subtitle || '',
            image: p.image || PHOTOS.drums,
            images: p.images,
          };
        });
        setProducts(mapped);
        setActiveProductId((prev) => (mapped.some((x) => x.id === prev) ? prev : mapped[0]?.id || ''));
      } else {
        setProducts([]);
      }
    } catch (err) {
      console.error('Failed to load DB products:', err);
      setProducts([]);
    } finally {
      setIsLoadingProducts(false);
    }
  };

  // Synchronize document attribute with theme state
  useEffect(() => {
    if (isDarkMode) {
      document.body.setAttribute('data-theme', 'dark');
      document.documentElement.setAttribute('data-theme', 'dark');
      document.documentElement.classList.add('dark');
    } else {
      document.body.setAttribute('data-theme', 'light');
      document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // Load products and categories on mount
  useEffect(() => {
    let isMounted = true;
    Promise.all([getProductsFromDb(), getCategoriesFromDb()])
      .then(([dbProducts, dbCategories]) => {
        if (!isMounted) return;

        if (dbCategories && dbCategories.length > 0) {
          setCategories(
            dbCategories.map((c) => {
              const slug = (c.slug || c.name || '').toLowerCase();
              let img = PHOTOS.drums;
              if (slug.includes('drum')) img = PHOTOS.drums;
              else if (slug.includes('guitar') || slug.includes('bass')) img = PHOTOS.guitars;
              else if (slug.includes('key') || slug.includes('piano') || slug.includes('synth')) img = PHOTOS.keyboards;
              else if (slug.includes('light')) img = PHOTOS.lighting;
              else if (slug.includes('speak') || slug.includes('pa')) img = PHOTOS.speakers;
              else if (slug.includes('mix') || slug.includes('audio') || slug.includes('mic')) img = PHOTOS.mixers;

              return {
                id: c.slug || c.id,
                name: c.name,
                sub: c.description || `${c.name} Gear`,
                image: c.image || img,
              };
            })
          );
        }

        if (dbProducts && dbProducts.length > 0) {
          const mapped: Product[] = dbProducts.map((p) => {
            let catKey = 'mixers';
            const c = (p.category || '').toLowerCase();
            if (c.includes('drum')) catKey = 'drums';
            else if (c.includes('guitar') || c.includes('bass')) catKey = 'guitars';
            else if (c.includes('key') || c.includes('piano') || c.includes('synth')) catKey = 'keyboards';
            else if (c.includes('light')) catKey = 'lighting';
            else if (c.includes('speak') || c.includes('pa')) catKey = 'speakers';
            else if (c.includes('mix') || c.includes('audio') || c.includes('mic')) catKey = 'mixers';

            return {
              id: p.id,
              name: p.name,
              cat: catKey,
              price: p.price,
              desc: p.description || p.subtitle || '',
              image: p.image || PHOTOS.drums,
              images: p.images,
            };
          });
          setProducts(mapped);
          setActiveProductId((prev) => (mapped.some((x) => x.id === prev) ? prev : mapped[0]?.id || ''));
        } else {
          setProducts([]);
        }
      })
      .catch((err) => {
        console.error('Failed to load DB products on mount:', err);
        if (isMounted) {
          setProducts([]);
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoadingProducts(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const productsCountByCat = useMemo(() => {
    const counts: Record<string, number> = {};
    products.forEach((p) => {
      counts[p.cat] = (counts[p.cat] || 0) + 1;
    });
    return counts;
  }, [products]);

  // Mixed / intermingled catalog products across categories for homepage showcase
  const mixedCatalogProducts = useMemo(() => {
    if (!products || products.length === 0) return [];
    
    // Group by category to interleave and mix evenly across categories
    const byCategory: Record<string, Product[]> = {};
    products.forEach((p) => {
      const c = p.cat || 'other';
      if (!byCategory[c]) byCategory[c] = [];
      byCategory[c].push(p);
    });

    const categoryKeys = Object.keys(byCategory);
    if (categoryKeys.length <= 1) {
      return [...products];
    }

    const mixed: Product[] = [];
    let hasMore = true;
    let index = 0;

    while (hasMore) {
      hasMore = false;
      for (const cat of categoryKeys) {
        if (index < byCategory[cat].length) {
          mixed.push(byCategory[cat][index]);
          hasMore = true;
        }
      }
      index++;
    }

    return mixed.length > 0 ? mixed : products;
  }, [products]);

  // Listen to Supabase Auth state changes
  useEffect(() => {
    const initAuth = async () => {
      const session = await getCurrentSession();
      if (session?.user) {
        const profile = await fetchUserProfile(session.user.id);
        setCurrentUser({
          id: session.user.id,
          email: session.user.email || '',
          name: profile?.name || session.user.user_metadata?.full_name || session.user.email?.split('@')[0],
          role: profile?.role || 'customer',
        });
      }
    };
    initAuth();

    const { data: authListener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user) {
        const profile = await fetchUserProfile(session.user.id);
        setCurrentUser({
          id: session.user.id,
          email: session.user.email || '',
          name: profile?.name || session.user.user_metadata?.full_name || session.user.email?.split('@')[0],
          role: profile?.role || 'customer',
        });
      } else {
        setCurrentUser(null);
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  // Sync cart to Supabase carts & cart_items tables
  useEffect(() => {
    if (cart.length > 0) {
      syncCartWithDb(cart, currentUser?.id || undefined);
    }
  }, [cart, currentUser]);

  const toggleTheme = () => {
    const nextDark = !getThemeSnapshot();
    if (nextDark) {
      document.body.setAttribute('data-theme', 'dark');
      document.documentElement.classList.add('dark');
      try { localStorage.setItem('drum-palace-theme', 'dark'); } catch {}
    } else {
      document.body.removeAttribute('data-theme');
      document.documentElement.classList.remove('dark');
      try { localStorage.setItem('drum-palace-theme', 'light'); } catch {}
    }
    themeListeners.forEach((fn) => fn());
  };

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3500);
  };

  const openAdminPortal = () => {
    setShowAdminPortal(true);
  };

  const navigateTo = (newRoute: AppRoute | string) => {
    setRoute(newRoute as AppRoute);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openProductDetail = (id: string) => {
    setActiveProductId(id);
    setSelectedImageIndex(0);
    setDetailQty(1);
    navigateTo('product');
  };

  const toggleWishlist = (id: string) => {
    setWish((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        showToast('Removed from Wishlist');
      } else {
        next.add(id);
        showToast('Saved to Wishlist');
      }
      return next;
    });
  };

  const addToCart = (id: string, qtyToAdd: number = 1) => {
    setCart((prev) => {
      const index = prev.findIndex((item) => item.id === id);
      if (index > -1) {
        const next = [...prev];
        next[index].qty += qtyToAdd;
        return next;
      } else {
        return [...prev, { id, qty: qtyToAdd }];
      }
    });
    const prod = products.find((p) => p.id === id);
    showToast(`Added ${prod?.name || 'item'} to Cart`);
  };

  const updateCartQty = (id: string, delta: number) => {
    setCart((prev) => {
      return prev
        .map((item) => {
          if (item.id === id) {
            return { ...item, qty: item.qty + delta };
          }
          return item;
        })
        .filter((item) => item.qty > 0);
    });
  };

  const totalCartCount = cart.reduce((sum, item) => sum + item.qty, 0);

  const subtotal = cart.reduce((sum, item) => {
    const p = products.find((prod) => prod.id === item.id);
    return sum + (p ? p.price * item.qty : 0);
  }, 0);

  const deliveryFee = subtotal > 0 ? 25000 : 0;
  const grandTotal = subtotal + deliveryFee;

  const activeProduct = products.find((p) => p.id === activeProductId) || products[0];

  // Filtered products for shop
  const filteredProducts = products.filter((p) => {
    const matchesCat = filter === 'all' || p.cat.toLowerCase() === filter.toLowerCase();
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.desc.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCat && matchesSearch;
  });

  const handleSearchSubmit = (query: string) => {
    setSearchQuery(query);
    setFilter('all');
    navigateTo('shop');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginEmail || !loginPassword) return;

    if (isSupabaseConfigured) {
      const { user, error } = await signInWithEmail(loginEmail, loginPassword);
      if (error) {
        showToast(error.message || 'Login failed. Please check your credentials.');
        return;
      }
      if (user) {
        // Strictly fetch user role from the database profiles table
        const profile = await fetchUserProfile(user.id);
        const userRole = profile?.role === 'admin' ? 'admin' : 'customer';
        const userDisplayName = profile?.name || user.user_metadata?.full_name || loginEmail.split('@')[0];

        const userObj = {
          id: user.id,
          email: user.email || loginEmail,
          name: userDisplayName,
          role: userRole,
          phone: profile?.phone,
        };

        setCurrentUser(userObj);

        if (userRole === 'admin') {
          showToast(`Welcome Administrator, ${userDisplayName}! Opening Admin Dashboard…`);
          setShowAdminPortal(true);
          navigateTo('account');
        } else {
          showToast(`Welcome back, ${userDisplayName}!`);
          if (pendingCheckout) {
            setPendingCheckout(false);
            navigateTo('checkout');
          } else {
            navigateTo('account');
          }
        }
        return;
      }
    }

    // SECURITY: the old "offline fallback" logged in anyone whose email matched
    // a stored profile — without a password — and granted that profile's role.
    // It has been removed; sign-in requires Supabase Auth.
    showToast('Sign-in is currently unavailable. Please configure the cloud database connection.');
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (regPassword !== regConfirm) {
      setRegStatus('Passwords do not match.');
      return;
    }
    if (!regAgree) {
      setRegStatus('Please accept the terms and conditions.');
      return;
    }
    setRegStatus('Creating your account…');

    if (isSupabaseConfigured) {
      const { user, error } = await signUpWithEmail(regEmail, regPassword, regName);
      if (error) {
        setRegStatus(error.message || 'Could not create account.');
        return;
      }
      if (user) {
        setCurrentUser({ id: user.id, email: regEmail, name: regName, role: 'customer' });
        setRegStatus('Account created — welcome to Drum Palace!');
        setTimeout(() => {
          if (pendingCheckout) {
            setPendingCheckout(false);
            navigateTo('checkout');
          } else {
            navigateTo('account');
          }
          setRegStatus('');
        }, 800);
        return;
      }
    }

    // Local registration fallback
    setTimeout(() => {
      setCurrentUser({ id: 'local_user_reg', email: regEmail, name: regName, role: 'customer' });
      setRegStatus('Account created — welcome to Drum Palace!');
      setTimeout(() => {
        if (pendingCheckout) {
          setPendingCheckout(false);
          navigateTo('checkout');
        } else {
          navigateTo('account');
        }
        setRegStatus('');
      }, 800);
    }, 600);
  };

  const handleSocialLogin = async (provider: 'google' | 'apple') => {
    if (isSupabaseConfigured && provider === 'google') {
      const { error } = await signInWithOAuth('google');
      if (error) showToast(error.message);
      return;
    }
    setCurrentUser({ id: `${provider}_user`, email: `${provider}.user@drumpalace.ug`, name: `${provider.toUpperCase()} Musician`, role: 'customer' });
    showToast(`Signed in with ${provider.toUpperCase()}`);
    if (pendingCheckout) {
      setPendingCheckout(false);
      navigateTo('checkout');
    } else {
      navigateTo('account');
    }
  };

  const handleForgotPassword = async () => {
    if (!loginEmail) {
      showToast('Please enter your email address in the field first.');
      return;
    }
    if (isSupabaseConfigured) {
      const { error } = await resetPassword(loginEmail);
      if (error) {
        showToast(error.message);
        return;
      }
    }
    showToast(`Password reset link sent to ${loginEmail}.`);
  };

  const handleSignOut = async () => {
    if (isSupabaseConfigured) {
      await signOutUser();
    }
    setCurrentUser(null);
    showToast('Signed out of Drum Palace.');
  };

  const handleContactSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setContactStatus('Sending your message…');
    try {
      await saveContactMessageToDb({
        name: contactName,
        email: contactEmail,
        topic: contactTopic,
        message: contactMessage,
      });
      setContactStatus('Message sent — Drum Palace will get back to you soon.');
      setContactName('');
      setContactEmail('');
      setContactTopic('');
      setContactMessage('');
    } catch (err: any) {
      setContactStatus(err?.message || 'Could not send message. Please call us directly.');
    }
  };

  const handleCheckoutConfirm = async () => {
    if (cart.length === 0) {
      showToast('Your cart is empty.');
      return;
    }

    const effectivePhone = (momoPhone || checkoutPhone || currentUser?.phone || '').trim();
    if (paymentMethod === 'momo' && !effectivePhone) {
      showToast('Please enter your mobile phone number for the LivePay MTN/Airtel prompt.');
      return;
    }

    if (!checkoutAddress.trim()) {
      showToast('Please enter your delivery address and location details.');
      return;
    }

    const customerDisplayName = currentUser?.name || checkoutName.trim() || 'Valued Musician';
    const customerEmail = currentUser?.email || checkoutEmail.trim() || 'guest@drumpalace.ug';
    const customerShipping = checkoutAddress.trim();

    setIsProcessingPayment(true);
    showToast(paymentMethod === 'momo' ? 'Initiating LivePay mobile prompt…' : 'Processing order via LivePay Uganda…');

    try {
      const orderItems = cart.map((item) => {
        const prod = products.find((p) => p.id === item.id);
        return {
          productName: prod?.name || 'Instrument',
          quantity: item.qty,
          price: prod?.price || 0,
        };
      });

      // 1. Create the order through the SERVER API. The server validates the
      //    payload, recomputes the total from the line items, and records the
      //    order as Pending. Payment state can only advance via a verified webhook.
      let accessToken: string | null = null;
      if (currentUser?.id) {
        try {
          const { data: sessionData } = await supabase.auth.getSession();
          accessToken = sessionData?.session?.access_token || null;
        } catch {
          accessToken = null;
        }
      }
      const orderRes = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          customerName: customerDisplayName,
          customerEmail: customerEmail,
          items: orderItems,
          total: grandTotal,
          phone: effectivePhone,
          shippingAddress: customerShipping,
        }),
      });
      const orderData = await orderRes.json().catch(() => null);
      if (!orderRes.ok || !orderData?.success || !orderData.orderId) {
        showToast(orderData?.error || 'Could not create your order. Please try again.');
        return;
      }

      // 2. Initiate the LivePay payment. The server reads the amount from the
      //    database order — the client never controls the charged amount.
      const payRes = await fetch('/api/payments/livepay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: orderData.orderId,
          phoneNumber: effectivePhone,
          paymentMethod,
        }),
      });
      const payData = await payRes.json().catch(() => null);
      if (!payRes.ok || !payData?.success) {
        showToast(payData?.error || 'Payment could not be started. Your order is saved as pending.');
        return;
      }

      showToast(`Order #${orderData.orderNumber} created. Complete the LivePay prompt to pay. Total: ${formatMoney(grandTotal)}`);
      setCart([]);
      setMomoPhone('');
      setCheckoutName('');
      setCheckoutPhone('');
      setCheckoutEmail('');
      setCheckoutAddress('');
      navigateTo('home');
    } catch (err: any) {
      console.error('Checkout processing error:', err);
      showToast('Checkout failed. You have not been charged — please try again.');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-between selection:bg-[#049da4] selection:text-white bg-[var(--bg)] text-[var(--ink)]">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed bottom-6 right-6 z-50 rounded-xl bg-[#101a1b] text-white px-5 py-3 shadow-2xl border border-white/20 text-sm font-medium flex items-center gap-3 animate-fade-in">
          <span className="text-[#049da4] font-bold">✓</span>
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Admin Portal Modal */}
      {showAdminPortal && (
        <AdminPortal
          currentUser={currentUser}
          onClose={() => setShowAdminPortal(false)}
          onProductsUpdated={() => loadDbProducts()}
          onAdminAuthenticated={(admin) => {
            setCurrentUser(admin as any);
          }}
          currency="UGX"
        />
      )}

      {/* ========================================================= */}
      {/* ANNOUNCEMENT BAR & HEADER */}
      {/* ========================================================= */}
      {storeSettings.announcementActive && storeSettings.announcementText && (
        <div className="bg-[#101a1b] text-white text-[11px] sm:text-xs py-2 px-4 text-center font-medium tracking-wide border-b border-white/10 flex items-center justify-center gap-2">
          <span className="text-[var(--accent)] font-bold">⚡</span>
          <span>{storeSettings.announcementText}</span>
        </div>
      )}

      <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--bg)]/95 backdrop-blur-md transition-colors">
        <div className="shell flex h-[60px] xs:h-[68px] sm:h-[78px] md:h-[84px] items-center justify-between gap-1.5 xs:gap-3 sm:gap-6">
          {/* Brand Logo & Circular Emblem */}
          <button
            onClick={() => navigateTo('home')}
            className="flex items-center text-left focus:outline-none group cursor-pointer flex-shrink-0"
          >
            <div className="flex items-center gap-1.5 xs:gap-2 sm:gap-3">
              <DrumPalaceLogo size={140} />
            </div>
          </button>

          {/* Search Bar - Integrated in Nav Bar */}
          <div className="flex-1 max-w-[160px] xs:max-w-xs md:max-w-sm lg:max-w-md mx-1 sm:mx-2 md:mx-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = e.currentTarget.elements.namedItem('navSearch') as HTMLInputElement;
                if (input) handleSearchSubmit(input.value);
              }}
              className="relative flex items-center w-full"
            >
              <Search
                size={15}
                className="absolute left-2.5 sm:left-3 text-[var(--muted)] pointer-events-none"
              />
              <input
                name="navSearch"
                type="text"
                placeholder="Search gear..."
                defaultValue={searchQuery}
                className="w-full h-8 xs:h-9 sm:h-10 pl-8 sm:pl-9 pr-2.5 sm:pr-3 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[11px] xs:text-xs sm:text-sm text-[var(--ink)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] transition shadow-sm"
              />
            </form>
          </div>

          {/* Navigation Links - Desktop & Tablets */}
          <nav className="hidden lg:flex items-center gap-4 xl:gap-6 h-full">
            <button
              onClick={() => navigateTo('home')}
              className={`relative h-full flex items-center text-sm font-medium transition cursor-pointer ${
                route === 'home' ? 'text-[var(--accent)] font-bold' : 'text-[var(--ink)] hover:text-[var(--accent)]'
              }`}
            >
              Home
              {route === 'home' && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
              )}
            </button>

            <button
              onClick={() => {
                setFilter('all');
                setSearchQuery('');
                navigateTo('shop');
              }}
              className={`relative h-full flex items-center text-sm font-medium transition cursor-pointer ${
                route === 'shop' ? 'text-[var(--accent)] font-bold' : 'text-[var(--ink)] hover:text-[var(--accent)]'
              }`}
            >
              Shop
              {route === 'shop' && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
              )}
            </button>

            <button
              onClick={() => navigateTo('categories')}
              className={`relative h-full flex items-center text-sm font-medium transition cursor-pointer ${
                route === 'categories' ? 'text-[var(--accent)] font-bold' : 'text-[var(--ink)] hover:text-[var(--accent)]'
              }`}
            >
              Categories
              {route === 'categories' && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
              )}
            </button>

            <button
              onClick={() => navigateTo('track-order')}
              className={`relative h-full flex items-center text-sm font-medium transition cursor-pointer ${
                route === 'track-order' ? 'text-[var(--accent)] font-bold' : 'text-[var(--ink)] hover:text-[var(--accent)]'
              }`}
            >
              Track Order
              {route === 'track-order' && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
              )}
            </button>

            <button
              onClick={() => navigateTo('contact')}
              className={`relative h-full flex items-center text-sm font-medium transition cursor-pointer ${
                route === 'contact' ? 'text-[var(--accent)] font-bold' : 'text-[var(--ink)] hover:text-[var(--accent)]'
              }`}
            >
              Contact
              {route === 'contact' && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
              )}
            </button>
          </nav>

          {/* Header Action Buttons */}
          <div className="flex items-center gap-1.5 sm:gap-2.5">
            {/* Currency Pill / Settings trigger */}
            <button
              onClick={() => navigateTo('settings')}
              title="Change Currency & Settings"
              className="flex items-center gap-1 px-2.5 py-1 sm:py-1.5 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[11px] sm:text-xs font-bold text-[var(--ink)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition cursor-pointer shadow-2xs"
            >
              <span>{currency}</span>
              <span className="text-[9px] text-[var(--muted)]">▼</span>
            </button>

            {/* Admin Quick Trigger (if admin is signed in) */}
            {currentUser?.role === 'admin' && (
              <button
                onClick={openAdminPortal}
                title="Open Store Administration"
                className="rounded-full bg-[#049da4] text-white px-2 py-1 xs:px-2.5 text-[11px] xs:text-xs font-bold hover:bg-[#03858b] transition cursor-pointer flex items-center gap-1 shadow-xs"
              >
                <Shield size={12} />
                <span className="hidden sm:inline">Admin</span>
              </button>
            )}

            {/* Hamburger Menu Drawer Trigger */}
            <button
              onClick={() => setIsDrawerOpen(true)}
              aria-label="Open menu navigation"
              className="grid place-items-center h-8 w-8 sm:h-9 sm:w-9 rounded-lg text-[var(--ink)] hover:bg-[var(--surface-2)] transition cursor-pointer ml-0.5"
            >
              <Menu size={22} />
            </button>
          </div>
        </div>
      </header>

      {/* Slide-Out Navigation Drawer */}
      <MobileDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        currentRoute={route}
        onNavigate={navigateTo}
        cartCount={totalCartCount}
        wishlistCount={wish.size}
        currentUser={currentUser}
        onSignOut={handleSignOut}
        onOpenAdmin={openAdminPortal}
      />

      {/* ========================================================= */}
      {/* MAIN BODY ROUTE SWITCHER */}
      {/* ========================================================= */}
      <main className="flex-1 pb-16">
        {/* VIEW 1: HOME VIEW */}
        {route === 'home' && (
          <div>
            {/* Promotional Sonus Banner (Directly below Nav) */}
            <div className="w-full border-b border-[var(--line)] shadow-sm">
              <SonusBanner
                slides={storeSettings.bannerSlides}
                onNavigateToShop={(cat) => {
                  if (cat) setFilter(cat);
                  navigateTo('shop');
                }}
              />
            </div>

            <div className="shell mt-4 sm:mt-6">
              {/* HOT DEALS HORIZONTAL SLIDER (MAX 8 SLIDES) */}
              <section className="py-4 sm:py-5 mb-2 sm:mb-4 border-b border-[var(--line)]">
                <div className="flex items-center justify-between mb-3 sm:mb-4">
                  <div className="flex items-center gap-2">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-rose-500/10 text-rose-500 dark:bg-rose-500/20">
                      <Flame size={18} className="animate-pulse text-rose-500" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-[10px] sm:text-[11px] font-extrabold tracking-[1.8px] text-rose-500 uppercase">
                          HOT DEALS
                        </p>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-500 text-white uppercase tracking-wider">
                          Limited Stock
                        </span>
                      </div>
                      <h2 className="font-heading text-lg sm:text-xl md:text-[22px] font-bold text-[var(--ink)]">
                        Flash Discounts & Special Offers
                      </h2>
                    </div>
                  </div>

                  {/* Horizontal Scroll Navigation Controls */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        if (hotDealsScrollRef.current) {
                          hotDealsScrollRef.current.scrollBy({ left: -300, behavior: 'smooth' });
                        }
                      }}
                      aria-label="Scroll hot deals left"
                      className="w-8 h-8 rounded-full border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[var(--ink)] flex items-center justify-center shadow-sm transition active:scale-95 cursor-pointer"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (hotDealsScrollRef.current) {
                          hotDealsScrollRef.current.scrollBy({ left: 300, behavior: 'smooth' });
                        }
                      }}
                      aria-label="Scroll hot deals right"
                      className="w-8 h-8 rounded-full border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-[var(--ink)] flex items-center justify-center shadow-sm transition active:scale-95 cursor-pointer"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>

                {/* Horizontal Scrollable Slider */}
                <div
                  ref={hotDealsScrollRef}
                  className="flex items-stretch gap-3 sm:gap-4 overflow-x-auto pb-3 pt-1 scroll-smooth snap-x snap-mandatory scrollbar-thin no-scrollbar"
                  style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                >
                  {(() => {
                    const rawDeals = (storeSettings.hotDeals && storeSettings.hotDeals.length > 0)
                      ? storeSettings.hotDeals.filter(d => d.active !== false)
                      : DEFAULT_HOT_DEALS;

                    const configuredDeals = rawDeals.length > 0 ? rawDeals : DEFAULT_HOT_DEALS;

                    const activeDeals = configuredDeals.slice(0, 8).map((deal, idx) => {
                      // 1. Try finding by direct ID or slug in dynamic products list
                      let matchedProd = products.find(p => p.id === deal.productId || (p as any).slug === deal.productId);
                      
                      // 2. Try finding by matching title/name
                      if (!matchedProd && deal.customTitle) {
                        matchedProd = products.find(p => p.name.toLowerCase() === deal.customTitle?.toLowerCase());
                      }

                      // 3. Fallback to an existing product in the catalog if available
                      const prod = matchedProd || (products.length > 0 ? products[idx % products.length] : null);
                      
                      if (!prod) return null;
                      
                      const discount = deal.discountPercent || 25;
                      const badge = deal.customBadge || `${discount}% OFF`;
                      const dealImage = deal.customImage?.trim() || prod.image || "https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=700&q=85";
                      const dealTitle = deal.customTitle?.trim() || prod.name || "Hot Deal Instrument";
                      const dealPrice = deal.customPrice ?? prod.price ?? 1000000;
                      const originalPrice = deal.originalPrice ?? Math.round(dealPrice / (1 - discount / 100));
                      
                      return {
                        id: deal.id || `deal-${idx}`,
                        deal,
                        prod,
                        discount,
                        badge,
                        dealImage,
                        dealTitle,
                        dealPrice,
                        originalPrice
                      };
                    }).filter((item): item is NonNullable<typeof item> => item !== null);

                    if (activeDeals.length === 0) return null;

                    return activeDeals.map(({ id, deal, prod, discount, badge, dealImage, dealTitle, dealPrice, originalPrice }) => {
                      if (!prod) return null;

                      return (
                        <article
                          key={`hotdeal-${id}-${prod.id}`}
                          className="snap-start shrink-0 w-[220px] xs:w-[240px] sm:w-[260px] md:w-[280px] bg-[var(--surface)] border border-[var(--line)] rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all flex flex-col justify-between group relative"
                        >
                          {/* Discount / Promotional Badge */}
                          <div className="absolute top-2.5 left-2.5 z-10 flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-rose-600 text-white text-[10px] font-bold shadow-sm">
                            <Flame size={11} className="shrink-0" />
                            <span>{badge.includes('%') ? badge : `${badge} -${discount}%`}</span>
                          </div>

                          {/* Wishlist Button */}
                          <button
                            onClick={() => toggleWishlist(prod.id)}
                            aria-label="Save to wishlist"
                            className={`absolute right-2.5 top-2.5 z-10 h-7 w-7 sm:h-8 sm:w-8 rounded-full bg-[var(--surface)]/80 backdrop-blur-sm text-sm sm:text-base flex items-center justify-center transition cursor-pointer ${
                              wish.has(prod.id) ? 'text-[#e04e5c]' : 'text-[var(--ink)] hover:text-[#e04e5c]'
                            }`}
                          >
                            {wish.has(prod.id) ? '♥' : '♡'}
                          </button>

                          {/* Product Image */}
                          <div
                            className="relative aspect-[4/3] w-full overflow-hidden bg-[var(--surface-2)] cursor-pointer"
                            onClick={() => openProductDetail(prod.id)}
                          >
                            <Image
                              src={dealImage}
                              alt={dealTitle}
                              fill
                              referrerPolicy="no-referrer"
                              className="object-cover transition-transform duration-300 group-hover:scale-105"
                            />
                          </div>

                          {/* Product Details */}
                          <div className="p-3 sm:p-3.5 flex-1 flex flex-col justify-between">
                            <div>
                              <span className="text-[10px] font-bold text-[var(--accent)] uppercase tracking-wider block mb-1">
                                {prod.cat}
                              </span>
                              <h3
                                onClick={() => openProductDetail(prod.id)}
                                className="text-xs sm:text-sm font-bold text-[var(--ink)] mb-1 cursor-pointer hover:text-[var(--accent)] transition line-clamp-1"
                              >
                                {dealTitle}
                              </h3>
                              <div className="flex items-baseline gap-2 mb-2.5">
                                <p className="text-sm sm:text-base font-extrabold text-rose-600 dark:text-rose-400">
                                  {formatMoney(dealPrice)}
                                </p>
                                <p className="text-[11px] sm:text-xs text-[var(--muted)] line-through">
                                  {formatMoney(originalPrice)}
                                </p>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 pt-1">
                              <button
                                onClick={() => openProductDetail(prod.id)}
                                className="flex-1 rounded-lg border border-[var(--line)] hover:border-[var(--accent)] text-[var(--ink)] hover:text-[var(--accent)] text-[11px] sm:text-xs font-semibold py-1.5 px-2 text-center transition cursor-pointer"
                              >
                                Details
                              </button>
                              <button
                                onClick={() => {
                                  addToCart(prod.id, 1);
                                  showToast(`Added ${dealTitle} to cart`);
                                }}
                                className="flex-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[11px] sm:text-xs font-bold py-1.5 px-2 text-center transition shadow-sm cursor-pointer"
                              >
                                Claim Deal
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    });
                  })()}
                </div>
              </section>

              {/* Categories Section */}
              <section className="py-4 sm:py-5">
                <div className="flex items-center justify-between mb-3 sm:mb-4">
                  <div>
                    <p className="text-[10px] sm:text-[11px] font-bold tracking-[1.6px] text-[var(--accent)] uppercase mb-0.5 sm:mb-1">CATEGORIES</p>
                  </div>
                  <button
                    onClick={() => {
                      setFilter('all');
                      navigateTo('shop');
                    }}
                    className="text-xs sm:text-sm font-semibold text-[var(--accent)] hover:underline cursor-pointer"
                  >
                    View All Categories →
                  </button>
                </div>

                <div className="grid grid-cols-2 xs:grid-cols-3 sm:grid-cols-3 md:grid-cols-6 gap-2 sm:gap-3">
                  {categories.map((cat) => (
                    <article
                      key={cat.id}
                      className="bg-[var(--surface)] border border-[var(--line)] rounded-xl overflow-hidden text-center p-2 sm:p-2.5 pb-3 sm:pb-3.5 shadow-sm transition hover:shadow-md"
                    >
                      <div className="relative h-[86px] sm:h-[112px] w-full rounded-lg overflow-hidden mb-2 sm:mb-2.5">
                        <Image
                          src={cat.image}
                          alt={cat.name}
                          fill
                          referrerPolicy="no-referrer"
                          className="object-cover"
                        />
                      </div>
                      <h3 className="text-xs sm:text-sm md:text-[15px] font-bold text-[var(--ink)] mb-0.5 truncate">{cat.name}</h3>
                      <p className="text-[10px] sm:text-[11px] text-[var(--muted)] mb-2 truncate">{cat.sub}</p>
                      <button
                        onClick={() => {
                          setFilter(cat.id);
                          setSearchQuery('');
                          navigateTo('shop');
                        }}
                        className="w-full rounded-md border border-[var(--accent)] text-[var(--accent)] text-[11px] sm:text-xs font-semibold py-1 sm:py-1.5 px-2 hover:bg-[var(--accent)] hover:text-white transition cursor-pointer"
                      >
                        Shop Now
                      </button>
                    </article>
                  ))}
                </div>
              </section>

              {/* Mixed Catalog Instruments Section */}
              <section className="py-5 sm:py-7">
                <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 mb-4 sm:mb-5">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-[10px] sm:text-[11px] font-bold tracking-[1.6px] text-[var(--accent)] uppercase">
                        CATALOG SPOTLIGHT
                      </p>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20">
                        {products.length} {products.length === 1 ? 'Instrument' : 'Instruments'}
                      </span>
                    </div>
                    <h2 className="font-heading text-xl sm:text-2xl md:text-[25px] font-bold text-[var(--ink)]">
                      Top Picks for You
                    </h2>
                    <p className="text-xs sm:text-sm text-[var(--muted)] mt-0.5">
                      Diverse selection of stage, studio, and acoustic musical equipment
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setFilter('all');
                      navigateTo('shop');
                    }}
                    className="text-xs sm:text-sm font-semibold text-[var(--accent)] hover:underline cursor-pointer flex items-center gap-1 self-start sm:self-auto"
                  >
                    <span>View All in Shop</span>
                    <span>→</span>
                  </button>
                </div>

                {mixedCatalogProducts.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-4">
                    {mixedCatalogProducts.map((p) => {
                      const catName = categories.find((c) => c.id === p.cat)?.name || p.cat;
                      return (
                        <article
                          key={p.id}
                          className="bg-[var(--surface)] border border-[var(--line)] rounded-xl overflow-hidden relative shadow-[0_4px_12px_rgba(10,30,35,0.04)] hover:shadow-md transition flex flex-col justify-between group"
                        >
                          {/* Heart Button */}
                          <button
                            onClick={() => toggleWishlist(p.id)}
                            aria-label="Save to wishlist"
                            className={`absolute right-2 top-2 z-10 h-7 w-7 sm:h-8 sm:w-8 rounded-full bg-[var(--surface)]/80 backdrop-blur-sm text-base sm:text-lg flex items-center justify-center transition cursor-pointer ${
                              wish.has(p.id) ? 'text-[#e04e5c]' : 'text-[var(--ink)] hover:text-[#e04e5c]'
                            }`}
                          >
                            {wish.has(p.id) ? '♥' : '♡'}
                          </button>

                          {/* Category Tag */}
                          <div className="absolute left-2 top-2 z-10">
                            <span className="px-2 py-0.5 rounded-md bg-[var(--surface)]/90 backdrop-blur-sm text-[9px] sm:text-[10px] font-bold text-[var(--accent)] uppercase tracking-wider shadow-xs border border-[var(--line)]">
                              {catName}
                            </span>
                          </div>

                          <div 
                            className="relative aspect-[1.18] w-full overflow-hidden bg-[var(--surface-2)] cursor-pointer"
                            onClick={() => openProductDetail(p.id)}
                          >
                            <Image
                              src={p.image}
                              alt={p.name}
                              fill
                              referrerPolicy="no-referrer"
                              className="object-cover transition-transform duration-300 group-hover:scale-105"
                            />
                          </div>

                          <div className="p-2.5 sm:p-3 flex-1 flex flex-col justify-between">
                            <div>
                              <h3 
                                onClick={() => openProductDetail(p.id)}
                                className="text-xs sm:text-[14px] md:text-[15px] font-bold text-[var(--ink)] mb-0.5 cursor-pointer hover:text-[var(--accent)] transition line-clamp-1"
                              >
                                {p.name}
                              </h3>
                              <p className="text-[10px] sm:text-xs text-[var(--muted)] mb-1.5 line-clamp-1">
                                {p.desc ? p.desc.split('. ')[0] : 'Professional musical instrument'}
                              </p>
                              <p className="text-[13px] sm:text-[15px] md:text-[16px] font-bold text-[var(--accent)] mb-2.5">
                                {formatMoney(p.price)}
                              </p>
                            </div>

                            <div className="flex items-center gap-1.5 pt-1">
                              <button
                                onClick={() => openProductDetail(p.id)}
                                className="flex-1 rounded-md border border-[var(--line)] hover:border-[var(--accent)] text-[var(--ink)] hover:text-[var(--accent)] text-[11px] sm:text-xs font-semibold py-1.5 sm:py-2 text-center transition cursor-pointer"
                              >
                                Details
                              </button>
                              <button
                                onClick={() => addToCart(p.id, 1)}
                                className="flex-1 rounded-md bg-[var(--accent)] hover:opacity-90 text-white text-[11px] sm:text-xs font-semibold py-1.5 sm:py-2 text-center transition cursor-pointer"
                              >
                                Add to Cart
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-10 px-4 border border-dashed border-[var(--line)] rounded-2xl bg-[var(--surface-2)]/30">
                    <p className="text-sm font-semibold text-[var(--ink)] mb-1">Catalog is currently empty</p>
                    <p className="text-xs text-[var(--muted)] mb-4">Add your musical instruments from the Admin Portal to showcase them here.</p>
                    <button
                      onClick={() => setShowAdminPortal(true)}
                      className="px-4 py-2 rounded-xl bg-[var(--accent)] text-white text-xs font-bold hover:opacity-90 transition cursor-pointer"
                    >
                      Open Admin Portal
                    </button>
                  </div>
                )}
              </section>

              {/* Benefits Section */}
              <div className="border border-[var(--line)] rounded-2xl p-4 sm:p-5 my-4 sm:my-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5 sm:gap-4">
                <div className="sm:col-span-2 lg:col-span-1 text-left sm:pr-3">
                  <p className="text-[10px] sm:text-[11px] font-bold tracking-[1.6px] text-[var(--accent)] uppercase mb-1">WHY CHOOSE US?</p>
                  <h2 className="font-heading text-base sm:text-lg md:text-[20px] font-bold text-[var(--ink)] my-1">Built for Musicians</h2>
                  <p className="text-[11px] text-[var(--muted)]">Quality Gear. Fast Service. Real Support.</p>
                </div>

                <div className="border-t sm:border-t-0 sm:border-l border-[var(--line)] pt-3 sm:pt-0 sm:pl-4 text-left sm:text-center">
                  <i className="text-[24px] sm:text-[28px] text-[var(--accent)] not-italic block mb-1">♙</i>
                  <h4 className="text-xs sm:text-sm font-bold text-[var(--ink)] mb-0.5">Top Quality</h4>
                  <p className="text-[10px] sm:text-[11px] text-[var(--muted)]">Carefully selected premium products</p>
                </div>

                <div className="border-t sm:border-t-0 sm:border-l border-[var(--line)] pt-3 sm:pt-0 sm:pl-4 text-left sm:text-center">
                  <i className="text-[24px] sm:text-[28px] text-[var(--accent)] not-italic block mb-1">♧</i>
                  <h4 className="text-xs sm:text-sm font-bold text-[var(--ink)] mb-0.5">Fast Shipping</h4>
                  <p className="text-[10px] sm:text-[11px] text-[var(--muted)]">Quick & reliable delivery</p>
                </div>

                <div className="border-t sm:border-t-0 sm:border-l border-[var(--line)] pt-3 sm:pt-0 sm:pl-4 text-left sm:text-center">
                  <i className="text-[24px] sm:text-[28px] text-[var(--accent)] not-italic block mb-1">♧</i>
                  <h4 className="text-xs sm:text-sm font-bold text-[var(--ink)] mb-0.5">Customer Support</h4>
                  <p className="text-[10px] sm:text-[11px] text-[var(--muted)]">Here to help 24/7</p>
                </div>

                <div className="border-t sm:border-t-0 sm:border-l border-[var(--line)] pt-3 sm:pt-0 sm:pl-4 text-left sm:text-center">
                  <i className="text-[24px] sm:text-[28px] text-[var(--accent)] not-italic block mb-1">♢</i>
                  <h4 className="text-xs sm:text-sm font-bold text-[var(--ink)] mb-0.5">Secure Shopping</h4>
                  <p className="text-[10px] sm:text-[11px] text-[var(--muted)]">Safe & trusted checkout</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 2: SHOP ALL VIEW */}
        {route === 'shop' && (
          <div className="shell py-4 sm:py-6">
            <div className="mb-4 sm:mb-6">
              <p className="text-[10px] sm:text-[11px] font-bold tracking-[1.6px] text-[var(--accent)] uppercase mb-0.5 sm:mb-1">OUR COLLECTION</p>
              <h1 className="font-heading text-xl sm:text-2xl md:text-[30px] font-bold text-[var(--ink)]">Shop All</h1>
            </div>

            {/* Shop Search Bar */}
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-2.5 max-w-3xl mb-4 sm:mb-6">
              <label className="flex flex-1 items-center gap-3 bg-[var(--surface)] border border-[var(--line)] rounded-xl px-3.5 sm:px-4 py-0 shadow-[var(--shadow)]">
                <Search size={18} className="text-[var(--muted)] shrink-0" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search for instruments, lighting, speakers and more..."
                  className="h-[46px] sm:h-[50px] w-full border-0 outline-none bg-transparent text-[var(--ink)] text-xs sm:text-sm md:text-base placeholder:text-[var(--muted)]"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    title="Clear search query"
                    className="p-1 text-[var(--muted)] hover:text-[var(--ink)] rounded-full transition cursor-pointer"
                  >
                    <X size={16} />
                  </button>
                )}
              </label>
              <button
                type="button"
                onClick={() => {
                  const input = document.querySelector('input[placeholder*="Search for instruments"]') as HTMLInputElement;
                  if (input) input.focus();
                }}
                className="rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-5 py-2.5 sm:py-3 text-xs sm:text-sm font-semibold text-white hover:opacity-90 transition cursor-pointer flex items-center justify-center gap-2"
              >
                <Search size={15} />
                <span>Search</span>
              </button>
            </div>

            {/* Category Filter Chips - Horizontally scrollable on mobile */}
            <div className="flex gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar pb-2 sm:flex-wrap mb-4 sm:mb-6">
              <button
                onClick={() => setFilter('all')}
                className={`px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium border transition cursor-pointer whitespace-nowrap flex-shrink-0 ${
                  filter === 'all'
                    ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                    : 'bg-[var(--surface)] text-[var(--muted)] border-[var(--line)] hover:border-[var(--accent)]'
                }`}
              >
                All
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setFilter(cat.id)}
                  className={`px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium border transition cursor-pointer whitespace-nowrap flex-shrink-0 ${
                    filter === cat.id
                      ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                      : 'bg-[var(--surface)] text-[var(--muted)] border-[var(--line)] hover:border-[var(--accent)]'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>

            {/* Product Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-4">
              {filteredProducts.map((p) => (
                <article
                  key={p.id}
                  className="bg-[var(--surface)] border border-[var(--line)] rounded-xl overflow-hidden relative shadow-[0_4px_12px_rgba(10,30,35,0.04)] flex flex-col justify-between"
                >
                  <button
                    onClick={() => toggleWishlist(p.id)}
                    aria-label="Save to wishlist"
                    className={`absolute right-2 top-2 z-10 h-7 w-7 sm:h-8 sm:w-8 rounded-full bg-[var(--surface)]/80 backdrop-blur-sm text-base sm:text-lg flex items-center justify-center transition cursor-pointer ${
                      wish.has(p.id) ? 'text-[#e04e5c]' : 'text-[var(--ink)] hover:text-[#e04e5c]'
                    }`}
                  >
                    {wish.has(p.id) ? '♥' : '♡'}
                  </button>

                  <div 
                    className="relative aspect-[1.18] w-full overflow-hidden bg-[var(--surface-2)] cursor-pointer"
                    onClick={() => openProductDetail(p.id)}
                  >
                    <Image
                      src={p.image}
                      alt={p.name}
                      fill
                      referrerPolicy="no-referrer"
                      className="object-cover transition-transform duration-300 hover:scale-105"
                    />
                  </div>

                  <div className="p-2.5 sm:p-3 flex-1 flex flex-col justify-between">
                    <div>
                      <h3 
                        onClick={() => openProductDetail(p.id)}
                        className="text-xs sm:text-[14px] md:text-[15px] font-bold text-[var(--ink)] mb-0.5 cursor-pointer hover:text-[var(--accent)] transition line-clamp-1"
                      >
                        {p.name}
                      </h3>
                      <p className="text-[10px] sm:text-xs text-[var(--muted)] mb-1.5 line-clamp-1">
                        {p.desc.split('. ')[0]}
                      </p>
                      <p className="text-[13px] sm:text-[15px] md:text-[16px] font-bold text-[var(--accent)] mb-2.5">
                        {formatMoney(p.price)}
                      </p>
                    </div>

                    <button
                      onClick={() => openProductDetail(p.id)}
                      className="w-full rounded-md border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white text-[11px] sm:text-xs font-semibold py-1.5 sm:py-2 transition cursor-pointer"
                    >
                      View Details
                    </button>
                  </div>
                </article>
              ))}
            </div>

            {filteredProducts.length === 0 && (
              <div className="text-center py-12 sm:py-16 border border-dashed border-[var(--line)] rounded-2xl">
                <p className="text-base sm:text-lg text-[var(--muted)]">No matching instruments or audio gear found.</p>
                <button
                  onClick={() => {
                    setFilter('all');
                    setSearchQuery('');
                  }}
                  className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-xs sm:text-sm font-bold text-white hover:opacity-90"
                >
                  Reset Filters
                </button>
              </div>
            )}
          </div>
        )}

        {/* VIEW 3: PRODUCT DETAIL VIEW */}
        {route === 'product' && (
          <div className="shell py-4 sm:py-6">
            <button
              onClick={() => navigateTo('shop')}
              className="text-xs sm:text-sm font-semibold text-[var(--accent)] hover:underline flex items-center gap-1 mb-4 sm:mb-6 cursor-pointer"
            >
              ← Back to shop
            </button>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8 lg:gap-12 items-start max-w-5xl mx-auto">
              {/* Product Large Image */}
              <div className="flex flex-col gap-4">
                <div className="relative aspect-square w-full rounded-2xl overflow-hidden border border-[var(--line)] bg-[var(--surface-2)] shadow-md">
                  <Image
                    src={[activeProduct.image, ...(activeProduct.images || [])][selectedImageIndex] || activeProduct.image}
                    alt={activeProduct.name}
                    fill
                    priority
                    referrerPolicy="no-referrer"
                    className="object-cover"
                  />
                </div>
                {activeProduct.images && activeProduct.images.length > 0 && (
                  <div className="flex items-center gap-3 overflow-x-auto pb-2 scrollbar-thin">
                    {[activeProduct.image, ...activeProduct.images].map((img, idx) => (
                      <button
                        key={idx}
                        onClick={() => setSelectedImageIndex(idx)}
                        className={`relative w-16 h-16 sm:w-20 sm:h-20 shrink-0 rounded-xl overflow-hidden border-2 transition ${
                          selectedImageIndex === idx ? 'border-[var(--accent)] opacity-100' : 'border-transparent opacity-60 hover:opacity-100'
                        }`}
                      >
                        <Image
                          src={img}
                          alt={`${activeProduct.name} thumbnail ${idx + 1}`}
                          fill
                          referrerPolicy="no-referrer"
                          className="object-cover"
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Product Info Column */}
              <div className="flex flex-col">
                <p className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-[var(--accent)] mb-1">
                  {activeProduct.cat}
                </p>
                <h1 className="font-heading text-xl sm:text-2xl md:text-3xl lg:text-4xl font-bold text-[var(--ink)] mb-2">
                  {activeProduct.name}
                </h1>
                
                <div className="text-xl sm:text-2xl md:text-[28px] font-bold text-[var(--accent)] mb-2">
                  {formatMoney(activeProduct.price)}
                </div>

                <div className="flex items-center gap-2 text-amber-500 text-xs sm:text-sm mb-3 sm:mb-4">
                  <span>★★★★☆</span>
                  <span className="text-[var(--muted)] text-[11px] sm:text-xs font-medium">4.5 · 38 Reviews</span>
                </div>

                <hr className="border-t border-[var(--line)] my-3 sm:my-4" />

                <h3 className="text-xs sm:text-sm font-bold text-[var(--ink)] mb-1">Description</h3>
                <p className="text-xs sm:text-sm md:text-base text-[var(--muted)] leading-relaxed mb-5 sm:mb-6">
                  {activeProduct.desc}
                </p>

                <h3 className="text-xs sm:text-sm font-bold text-[var(--ink)] mb-1.5 sm:mb-2">Quantity</h3>
                <div className="flex items-center border border-[var(--line)] rounded-lg overflow-hidden w-36 sm:w-44 bg-[var(--surface)] mb-5 sm:mb-7">
                  <button
                    onClick={() => setDetailQty(Math.max(1, detailQty - 1))}
                    className="w-10 sm:w-12 h-10 sm:h-11 bg-[var(--surface-2)] text-[var(--ink)] text-lg sm:text-xl font-bold hover:bg-[var(--line)] transition"
                  >
                    −
                  </button>
                  <span className="flex-1 text-center font-bold text-xs sm:text-sm text-[var(--ink)]">
                    {detailQty}
                  </span>
                  <button
                    onClick={() => setDetailQty(detailQty + 1)}
                    className="w-10 sm:w-12 h-10 sm:h-11 bg-[var(--surface-2)] text-[var(--ink)] text-lg sm:text-xl font-bold hover:bg-[var(--line)] transition"
                  >
                    +
                  </button>
                </div>

                <div className="flex flex-col sm:flex-row gap-2.5 sm:gap-3">
                  <button
                    onClick={() => addToCart(activeProduct.id, detailQty)}
                    className="flex-1 rounded-xl border border-[var(--accent)] text-[var(--accent)] font-semibold py-3 sm:py-3.5 px-4 hover:bg-[var(--accent)]/10 transition cursor-pointer text-center text-xs sm:text-sm"
                  >
                    🛒 Add to Cart
                  </button>
                  <button
                    onClick={() => {
                      addToCart(activeProduct.id, detailQty);
                      navigateTo('checkout');
                    }}
                    className="flex-1 rounded-xl bg-[var(--accent)] text-white font-semibold py-3 sm:py-3.5 px-4 hover:opacity-90 transition cursor-pointer text-center text-xs sm:text-sm shadow-sm"
                  >
                    Buy Now
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 4: CART VIEW */}
        {route === 'cart' && (
          <div className="shell py-4 sm:py-6 max-w-5xl">
            <button
              onClick={() => navigateTo('shop')}
              className="text-xs sm:text-sm font-semibold text-[var(--accent)] hover:underline flex items-center gap-1 mb-4 cursor-pointer"
            >
              ← Continue shopping
            </button>

            <h1 className="font-heading text-xl sm:text-2xl md:text-3xl font-bold text-[var(--ink)] mb-4 sm:mb-6">
              My Cart ({totalCartCount})
            </h1>

            {cart.length === 0 ? (
              <div className="text-center py-12 sm:py-16 border border-dashed border-[var(--line)] rounded-2xl bg-[var(--surface)]">
                <i className="text-3xl sm:text-4xl text-[var(--muted)] not-italic block mb-3">🛒</i>
                <p className="text-sm sm:text-base text-[var(--muted)] mb-4">
                  Your cart is empty. Browse our collection to add something special.
                </p>
                <button
                  onClick={() => navigateTo('shop')}
                  className="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-xs sm:text-sm font-bold text-white hover:opacity-90"
                >
                  Browse Store
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
                {/* Cart Items List */}
                <div className="lg:col-span-7 xl:col-span-8 space-y-3">
                  {cart.map((item) => {
                    const prod = products.find((p) => p.id === item.id);
                    if (!prod) return null;
                    return (
                      <article
                        key={item.id}
                        className="bg-[var(--surface)] border border-[var(--line)] rounded-xl p-3 sm:p-3.5 flex items-center gap-3 sm:gap-4 shadow-sm"
                      >
                        <div className="relative h-14 w-14 sm:h-20 sm:w-20 rounded-lg overflow-hidden bg-[var(--surface-2)] flex-shrink-0">
                          <Image
                            src={prod.image}
                            alt={prod.name}
                            fill
                            referrerPolicy="no-referrer"
                            className="object-cover"
                          />
                        </div>

                        <div className="flex-1 min-w-0">
                          <h3 className="text-xs sm:text-sm md:text-base font-bold text-[var(--ink)] truncate mb-0.5 sm:mb-1">
                            {prod.name}
                          </h3>
                          <p className="text-xs sm:text-sm font-bold text-[var(--accent)]">
                            {formatMoney(prod.price)}
                          </p>
                        </div>

                        <div className="flex items-center border border-[var(--line)] rounded-lg overflow-hidden bg-[var(--surface)] flex-shrink-0">
                          <button
                            onClick={() => updateCartQty(item.id, -1)}
                            className="w-7 h-7 sm:w-9 sm:h-9 bg-[var(--surface-2)] text-[var(--ink)] font-bold hover:bg-[var(--line)] text-xs sm:text-sm"
                          >
                            −
                          </button>
                          <span className="w-6 sm:w-10 text-center font-bold text-xs sm:text-sm text-[var(--ink)]">
                            {item.qty}
                          </span>
                          <button
                            onClick={() => updateCartQty(item.id, 1)}
                            className="w-7 h-7 sm:w-9 sm:h-9 bg-[var(--surface-2)] text-[var(--ink)] font-bold hover:bg-[var(--line)] text-xs sm:text-sm"
                          >
                            +
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>

                {/* Cart Summary */}
                <div className="lg:col-span-5 xl:col-span-4 bg-[var(--surface-2)] border border-[var(--line)] rounded-2xl p-4 sm:p-5 shadow-sm lg:sticky lg:top-24">
                  <h2 className="font-heading text-base sm:text-lg font-bold text-[var(--ink)] mb-3">
                    Order Summary
                  </h2>
                  <div className="flex justify-between text-xs sm:text-sm text-[var(--muted)] mb-2">
                    <span>Subtotal</span>
                    <span className="font-semibold text-[var(--ink)]">{formatMoney(subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-xs sm:text-sm text-[var(--muted)] mb-3">
                    <span>Delivery fee</span>
                    <span className="font-semibold text-[var(--ink)]">{formatMoney(deliveryFee)}</span>
                  </div>
                  <div className="flex justify-between text-base sm:text-xl font-bold text-[var(--ink)] border-t border-[var(--line)] pt-3">
                    <span>Total</span>
                    <span className="text-[var(--accent)]">{formatMoney(grandTotal)}</span>
                  </div>

                  <button
                    onClick={() => {
                      if (!currentUser) {
                        setPendingCheckout(true);
                        showToast('An account is required to place an order. Please sign in or register.');
                        navigateTo('login');
                      } else {
                        navigateTo('checkout');
                      }
                    }}
                    className="w-full mt-4 sm:mt-5 rounded-xl bg-[var(--accent)] py-3 sm:py-3.5 text-xs sm:text-base font-bold text-white hover:opacity-90 transition cursor-pointer shadow-sm"
                  >
                    Proceed to Checkout
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* VIEW 5: CHECKOUT VIEW */}
        {route === 'checkout' && (
          <div className="shell py-4 sm:py-6 max-w-5xl">
            <button
              onClick={() => navigateTo('cart')}
              className="text-xs sm:text-sm font-semibold text-[var(--accent)] hover:underline flex items-center gap-1 mb-4 cursor-pointer"
            >
              ← Back to cart
            </button>

            <h1 className="font-heading text-xl sm:text-2xl md:text-3xl font-bold text-[var(--ink)] mb-4 sm:mb-6">
              Complete Your Order
            </h1>

            {cart.length === 0 ? (
              <div className="text-center py-12 border border-dashed border-[var(--line)] rounded-xl">
                <p className="text-[var(--muted)] mb-4">Your cart is empty.</p>
                <button
                  onClick={() => navigateTo('shop')}
                  className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-bold text-white"
                >
                  Shop Now
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
                {/* Left Form: Customer and Payment details */}
                <div className="lg:col-span-7 space-y-5">
                  {/* Customer Information Section */}
                  {currentUser ? (
                    <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-xl p-3.5 sm:p-4 flex items-center justify-between shadow-sm">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-[var(--accent)] text-white font-bold flex items-center justify-center text-xs sm:text-sm shadow-sm flex-shrink-0">
                          {(currentUser.name || currentUser.email)[0].toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-xs sm:text-sm font-bold text-[var(--ink)] truncate">
                              {currentUser.name || 'Drum Palace Member'}
                            </p>
                            <span className="text-[9px] sm:text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                              ✓ Signed In
                            </span>
                          </div>
                          <p className="text-[11px] sm:text-xs text-[var(--muted)] truncate">{currentUser.email}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          handleSignOut();
                          setPendingCheckout(true);
                          navigateTo('login');
                        }}
                        className="text-xs text-[var(--accent)] hover:underline font-semibold cursor-pointer flex-shrink-0 ml-2"
                      >
                        Switch Account
                      </button>
                    </div>
                  ) : (
                    <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-xl p-4 sm:p-5 space-y-3 shadow-sm">
                      <div className="flex items-center justify-between border-b border-[var(--line)] pb-2">
                        <h2 className="text-xs sm:text-sm font-bold text-[var(--ink)] flex items-center gap-1.5">
                          <span>👤</span> Customer & Delivery Information
                        </h2>
                        <button
                          onClick={() => {
                            setPendingCheckout(true);
                            navigateTo('login');
                          }}
                          className="text-[11px] sm:text-xs text-[var(--accent)] hover:underline font-semibold cursor-pointer"
                        >
                          Have an account? Sign in
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-bold text-[var(--ink)] mb-1">Full Name</label>
                          <input
                            type="text"
                            placeholder="e.g. John Okello"
                            value={checkoutName}
                            onChange={(e) => setCheckoutName(e.target.value)}
                            className="w-full bg-[var(--surface)] border border-[var(--line)] rounded-lg p-2.5 text-xs sm:text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-[var(--ink)] mb-1">Email Address</label>
                          <input
                            type="email"
                            placeholder="e.g. okello@gmail.com"
                            value={checkoutEmail}
                            onChange={(e) => setCheckoutEmail(e.target.value)}
                            className="w-full bg-[var(--surface)] border border-[var(--line)] rounded-lg p-2.5 text-xs sm:text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Delivery & Contact Information - Always Visible */}
                  <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-xl p-4 sm:p-5 space-y-3 shadow-sm mt-5">
                    <div className="flex items-center justify-between border-b border-[var(--line)] pb-2">
                      <h2 className="text-xs sm:text-sm font-bold text-[var(--ink)] flex items-center gap-1.5">
                        <span>📍</span> Delivery Information
                      </h2>
                    </div>
                    <div className="grid grid-cols-1 gap-3">
                      <div>
                        <label className="block text-[11px] font-bold text-[var(--ink)] mb-1">Contact Phone</label>
                        <input
                          type="tel"
                          placeholder="+256 7XX XXX XXX"
                          value={checkoutPhone}
                          onChange={(e) => {
                            setCheckoutPhone(e.target.value);
                            if (!momoPhone) setMomoPhone(e.target.value);
                          }}
                          className="w-full bg-[var(--surface)] border border-[var(--line)] rounded-lg p-2.5 text-xs sm:text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-[var(--ink)] mb-1">Delivery Address & Location Details (Uganda)</label>
                        <textarea
                          rows={2}
                          placeholder="e.g. Kampala, Plot 12, NSSF Building. Next to the main entrance..."
                          value={checkoutAddress}
                          onChange={(e) => setCheckoutAddress(e.target.value)}
                          className="w-full bg-[var(--surface)] border border-[var(--line)] rounded-lg p-2.5 text-xs sm:text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)] resize-none"
                        />
                        <p className="text-[10px] text-[var(--muted)] mt-1">Please provide specific details like district, street, or nearby landmarks so we can deliver your order accurately.</p>
                      </div>
                    </div>
                  </div>

                  {/* Payment Method Selector */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="font-heading text-base sm:text-lg font-bold text-[var(--ink)]">
                        Select Payment Method
                      </h2>
                      <span className="text-[9px] sm:text-[10px] font-bold tracking-wider px-2 py-0.5 rounded bg-[var(--hero-tint)] text-[var(--accent)] border border-[var(--line)]">
                        LIVEPAY SECURED
                      </span>
                    </div>

                    <div className="space-y-2.5">
                      <button
                        onClick={() => setPaymentMethod('momo')}
                        disabled={isProcessingPayment}
                        className={`w-full text-left p-3.5 sm:p-4 rounded-xl border transition flex items-center justify-between cursor-pointer text-xs sm:text-sm ${
                          paymentMethod === 'momo'
                            ? 'border-[var(--accent)] bg-[var(--surface)] ring-1 ring-[var(--accent)] font-bold text-[var(--ink)]'
                            : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:border-[var(--accent)]'
                        }`}
                      >
                        <span>🟨 &nbsp; MTN MoMo &nbsp;|&nbsp; Airtel Money (LivePay)</span>
                        {paymentMethod === 'momo' && <span className="text-[var(--accent)] font-bold">✓</span>}
                      </button>

                      <button
                        onClick={() => setPaymentMethod('card')}
                        disabled={isProcessingPayment}
                        className={`w-full text-left p-3.5 sm:p-4 rounded-xl border transition flex items-center justify-between cursor-pointer text-xs sm:text-sm ${
                          paymentMethod === 'card'
                            ? 'border-[var(--accent)] bg-[var(--surface)] ring-1 ring-[var(--accent)] font-bold text-[var(--ink)]'
                            : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:border-[var(--accent)]'
                        }`}
                      >
                        <span>💳 &nbsp; Visa / Mastercard / Debit (LivePay)</span>
                        {paymentMethod === 'card' && <span className="text-[var(--accent)] font-bold">✓</span>}
                      </button>

                      <button
                        onClick={() => setPaymentMethod('cod')}
                        disabled={isProcessingPayment}
                        className={`w-full text-left p-3.5 sm:p-4 rounded-xl border transition flex items-center justify-between cursor-pointer text-xs sm:text-sm ${
                          paymentMethod === 'cod'
                            ? 'border-[var(--accent)] bg-[var(--surface)] ring-1 ring-[var(--accent)] font-bold text-[var(--ink)]'
                            : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:border-[var(--accent)]'
                        }`}
                      >
                        <span>💵 &nbsp; Cash on Delivery</span>
                        {paymentMethod === 'cod' && <span className="text-[var(--accent)] font-bold">✓</span>}
                      </button>
                    </div>
                  </div>

                  {/* Mobile Money Input */}
                  {paymentMethod === 'momo' && (
                    <div className="bg-[var(--surface-2)] p-4 sm:p-5 border border-[var(--line)] rounded-xl">
                      <label className="block text-xs font-bold text-[var(--ink)] mb-2">
                        Enter Mobile Phone Number (MTN / Airtel Uganda)
                      </label>
                      <input
                        type="text"
                        disabled={isProcessingPayment}
                        value={momoPhone}
                        onChange={(e) => setMomoPhone(e.target.value)}
                        placeholder="+256 7XX XXX XXX"
                        className="w-full bg-[var(--surface)] border border-[var(--line)] rounded-lg p-3 text-xs sm:text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)] mb-3"
                      />
                      <button
                        onClick={handleCheckoutConfirm}
                        disabled={isProcessingPayment}
                        className="w-full rounded-xl bg-[var(--accent)] py-3 text-xs sm:text-sm font-bold text-white hover:opacity-90 cursor-pointer disabled:opacity-50"
                      >
                        {isProcessingPayment ? 'Processing LivePay Prompt…' : 'Pay Now with LivePay MoMo'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Right Column: Order items preview & Summary */}
                <div className="lg:col-span-5 bg-[var(--surface-2)] border border-[var(--line)] rounded-2xl p-4 sm:p-5 shadow-sm lg:sticky lg:top-24 space-y-4">
                  <h2 className="font-heading text-base sm:text-lg font-bold text-[var(--ink)] border-b border-[var(--line)] pb-2.5">
                    Order Overview
                  </h2>

                  {/* Checkout Item Preview List */}
                  <div className="space-y-2.5 max-h-56 overflow-y-auto pr-1">
                    {cart.map((cItem) => {
                      const prod = products.find((p) => p.id === cItem.id);
                      if (!prod) return null;
                      return (
                        <div key={cItem.id} className="flex items-center gap-3 bg-[var(--surface)] p-2.5 rounded-lg border border-[var(--line)]">
                          <div className="relative h-11 w-11 rounded-md overflow-hidden bg-[var(--surface-2)] flex-shrink-0">
                            <Image
                              src={prod.image}
                              alt={prod.name}
                              fill
                              referrerPolicy="no-referrer"
                              className="object-cover"
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold text-[var(--ink)] truncate">{prod.name}</p>
                            <p className="text-[11px] text-[var(--muted)]">Qty: {cItem.qty} × {formatMoney(prod.price)}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Cost Summary */}
                  <div className="border-t border-[var(--line)] pt-3 space-y-2">
                    <div className="flex justify-between text-xs sm:text-sm text-[var(--muted)]">
                      <span>Subtotal</span>
                      <span className="font-semibold text-[var(--ink)]">{formatMoney(subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-xs sm:text-sm text-[var(--muted)]">
                      <span>Delivery (Uganda)</span>
                      <span className="font-semibold text-[var(--ink)]">{formatMoney(deliveryFee)}</span>
                    </div>
                    <div className="flex justify-between text-base sm:text-xl font-bold text-[var(--ink)] border-t border-[var(--line)] pt-2.5">
                      <span>Grand Total</span>
                      <span className="text-[var(--accent)]">{formatMoney(grandTotal)}</span>
                    </div>
                  </div>

                  <button
                    onClick={handleCheckoutConfirm}
                    disabled={isProcessingPayment}
                    className="w-full rounded-xl bg-[var(--accent)] py-3.5 text-xs sm:text-sm md:text-base font-bold text-white hover:opacity-90 transition cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm"
                  >
                    {isProcessingPayment ? (
                      <>
                        <span className="animate-spin inline-block">◌</span>
                        <span>Connecting to LivePay…</span>
                      </>
                    ) : (
                      <span>Confirm Payment with LivePay</span>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* VIEW 6: LOGIN VIEW (When not logged in) */}
        {route === 'login' && !currentUser && (
          <div className="min-h-[calc(100vh-180px)] grid place-items-center py-12 px-4 bg-[radial-gradient(circle_at_50%_0,var(--hero-tint),transparent_42%)]">
            <div className="w-full max-w-[460px] bg-[var(--surface)] border border-[var(--line)] rounded-2xl p-7 sm:p-9 shadow-[var(--shadow)]">
              {pendingCheckout && (
                <div className="mb-5 p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-800 dark:text-amber-200 flex items-start gap-3 shadow-xs">
                  <span className="text-lg">🛒</span>
                  <div>
                    <strong className="block font-bold">Sign in to complete your order</strong>
                    <span>Your order of <span className="font-bold text-[var(--accent)]">{formatMoney(grandTotal)}</span> is ready. Sign in to confirm shipping and proceed to payment.</span>
                  </div>
                </div>
              )}
              <div className="w-13 h-13 rounded-full bg-[var(--hero-tint)] text-[var(--accent)] border border-[var(--line)] grid place-items-center mx-auto mb-4 text-2xl">
                ♬
              </div>
              <h1 className="text-center font-heading text-2xl sm:text-[29px] font-bold text-[var(--ink)] mb-1">
                Welcome back
              </h1>
              <p className="text-center text-xs sm:text-sm text-[var(--muted)] mb-6">
                Sign in to your Drum Palace account.
              </p>

              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-[var(--ink)] mb-1.5" htmlFor="loginEmail">
                    Email address
                  </label>
                  <input
                    id="loginEmail"
                    type="email"
                    required
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] rounded-lg p-3 text-sm outline-none focus:border-[var(--accent)]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--ink)] mb-1.5" htmlFor="loginPassword">
                    Password
                  </label>
                  <input
                    id="loginPassword"
                    type="password"
                    required
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] rounded-lg p-3 text-sm outline-none focus:border-[var(--accent)]"
                  />
                </div>

                <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" className="rounded" /> Remember me
                  </label>
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    className="text-[var(--accent)] font-semibold hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>

                <button
                  type="submit"
                  className="w-full rounded-lg bg-[var(--accent)] py-3.5 text-sm font-bold text-white hover:opacity-90 transition cursor-pointer"
                >
                  Sign in
                </button>
              </form>

              <div className="flex items-center gap-2.5 text-xs text-[var(--muted)] my-5 before:h-[1px] before:flex-1 before:bg-[var(--line)] after:h-[1px] after:flex-1 after:bg-[var(--line)]">
                OR CONTINUE WITH
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => handleSocialLogin('google')}
                  className="rounded-lg border border-[var(--line)] bg-[var(--surface)] py-2.5 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface-2)] cursor-pointer"
                >
                  G &nbsp; Google
                </button>
                <button
                  type="button"
                  onClick={() => handleSocialLogin('apple')}
                  className="rounded-lg border border-[var(--line)] bg-[var(--surface)] py-2.5 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface-2)] cursor-pointer"
                >
                  ● &nbsp; Apple
                </button>
              </div>

              <p className="text-center text-xs text-[var(--muted)] mt-6">
                New to Drum Palace?{' '}
                <button
                  onClick={() => navigateTo('register')}
                  className="text-[var(--accent)] font-bold hover:underline cursor-pointer"
                >
                  Create an account
                </button>
              </p>
            </div>
          </div>
        )}

        {/* VIEW 7: REGISTER VIEW */}
        {route === 'register' && (
          <div className="min-h-[calc(100vh-180px)] grid place-items-center py-12 px-4 bg-[radial-gradient(circle_at_50%_0,var(--hero-tint),transparent_42%)]">
            <div className="w-full max-w-[460px] bg-[var(--surface)] border border-[var(--line)] rounded-2xl p-7 sm:p-9 shadow-[var(--shadow)]">
              {pendingCheckout && (
                <div className="mb-5 p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-800 dark:text-amber-200 flex items-start gap-3 shadow-xs">
                  <span className="text-lg">🛒</span>
                  <div>
                    <strong className="block font-bold">Create account to finish order</strong>
                    <span>Your order of <span className="font-bold text-[var(--accent)]">{formatMoney(grandTotal)}</span> will be linked to your new account immediately upon registration.</span>
                  </div>
                </div>
              )}
              <div className="w-13 h-13 rounded-full bg-[var(--hero-tint)] text-[var(--accent)] border border-[var(--line)] grid place-items-center mx-auto mb-4 text-2xl">
                ♪
              </div>
              <h1 className="text-center font-heading text-2xl sm:text-[29px] font-bold text-[var(--ink)] mb-1">
                Create your account
              </h1>
              <p className="text-center text-xs sm:text-sm text-[var(--muted)] mb-6">
                Save your favorite gear and check out faster.
              </p>

              <form onSubmit={handleRegister} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-semibold text-[var(--ink)] mb-1" htmlFor="regName">
                    Full name
                  </label>
                  <input
                    id="regName"
                    type="text"
                    required
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    placeholder="Your full name"
                    className="w-full border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] rounded-lg p-2.5 text-sm outline-none focus:border-[var(--accent)]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--ink)] mb-1" htmlFor="regEmail">
                    Email address
                  </label>
                  <input
                    id="regEmail"
                    type="email"
                    required
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] rounded-lg p-2.5 text-sm outline-none focus:border-[var(--accent)]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--ink)] mb-1" htmlFor="regPassword">
                    Password
                  </label>
                  <input
                    id="regPassword"
                    type="password"
                    required
                    minLength={8}
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="w-full border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] rounded-lg p-2.5 text-sm outline-none focus:border-[var(--accent)]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--ink)] mb-1" htmlFor="regConfirm">
                    Confirm password
                  </label>
                  <input
                    id="regConfirm"
                    type="password"
                    required
                    value={regConfirm}
                    onChange={(e) => setRegConfirm(e.target.value)}
                    placeholder="Repeat your password"
                    className="w-full border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] rounded-lg p-2.5 text-sm outline-none focus:border-[var(--accent)]"
                  />
                </div>

                <div className="flex items-center gap-2 text-xs text-[var(--muted)] pt-1">
                  <input
                    type="checkbox"
                    id="terms"
                    required
                    checked={regAgree}
                    onChange={(e) => setRegAgree(e.target.checked)}
                  />
                  <label htmlFor="terms">I agree to the terms & conditions</label>
                </div>

                <button
                  type="submit"
                  className="w-full rounded-lg bg-[var(--accent)] py-3.5 text-sm font-bold text-white hover:opacity-90 transition cursor-pointer mt-2"
                >
                  Create account
                </button>

                {regStatus && (
                  <p className="text-center text-xs text-[var(--muted)] pt-2 font-medium">
                    {regStatus}
                  </p>
                )}
              </form>

              <p className="text-center text-xs text-[var(--muted)] mt-6">
                Already have an account?{' '}
                <button
                  onClick={() => navigateTo('login')}
                  className="text-[var(--accent)] font-bold hover:underline cursor-pointer"
                >
                  Sign in
                </button>
              </p>
            </div>
          </div>
        )}

        {/* VIEW 8: CONTACT VIEW */}
        {route === 'contact' && (
          <div className="shell py-8 sm:py-12">
            <div className="text-center max-w-2xl mx-auto mb-9">
              <p className="text-[11px] font-bold tracking-[1.6px] text-[var(--accent)] uppercase mb-1">GET IN TOUCH</p>
              <h1 className="font-heading text-2xl sm:text-4xl font-bold text-[var(--ink)] mb-2">
                Let’s make some noise together.
              </h1>
              <p className="text-sm sm:text-base text-[var(--muted)] leading-relaxed">
                Questions about an instrument, your order, or a custom setup? Our Drum Palace team is ready to help.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start max-w-5xl mx-auto">
              {/* Contact Info Sidebar */}
              <aside className="lg:col-span-5 bg-[var(--surface)] border border-[var(--line)] rounded-2xl p-6 shadow-sm">
                <h2 className="font-heading text-lg font-bold text-[var(--ink)] mb-4">
                  Contact Drum Palace
                </h2>

                <div className="space-y-4">
                  <div className="flex items-start gap-3 pb-3.5 border-b border-[var(--line)]">
                    <span className="h-9 w-9 rounded-lg bg-[var(--hero-tint)] text-[var(--accent)] grid place-items-center text-base flex-shrink-0">
                      ☎
                    </span>
                    <div>
                      <strong className="block text-xs text-[var(--ink)] mb-0.5">Phone & WhatsApp</strong>
                      <a href={`tel:${storeSettings.contactPhone.replace(/\s+/g, '')}`} className="text-xs text-[var(--muted)] hover:text-[var(--accent)]">
                        {storeSettings.contactPhone || '+256 700 123 456'}
                      </a>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 pb-3.5 border-b border-[var(--line)]">
                    <span className="h-9 w-9 rounded-lg bg-[var(--hero-tint)] text-[var(--accent)] grid place-items-center text-base flex-shrink-0">
                      ✉
                    </span>
                    <div>
                      <strong className="block text-xs text-[var(--ink)] mb-0.5">Email</strong>
                      <a href={`mailto:${storeSettings.contactEmail}`} className="text-xs text-[var(--muted)] hover:text-[var(--accent)]">
                        {storeSettings.contactEmail || 'info@drumpalace.ug'}
                      </a>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 pb-3.5 border-b border-[var(--line)]">
                    <span className="h-9 w-9 rounded-lg bg-[var(--hero-tint)] text-[var(--accent)] grid place-items-center text-base flex-shrink-0">
                      ⌖
                    </span>
                    <div>
                      <strong className="block text-xs text-[var(--ink)] mb-0.5">Store Location</strong>
                      <span className="text-xs text-[var(--muted)]">
                        {storeSettings.contactAddress || 'Plot 14, Kampala Road, Music District, Uganda'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <span className="h-9 w-9 rounded-lg bg-[var(--hero-tint)] text-[var(--accent)] grid place-items-center text-base flex-shrink-0">
                      ⌘
                    </span>
                    <div>
                      <strong className="block text-xs text-[var(--ink)] mb-0.5">Website</strong>
                      <a href="https://drumpalace.ug" target="_blank" rel="noreferrer" className="text-xs text-[var(--muted)] hover:text-[var(--accent)]">
                        www.drumpalace.ug
                      </a>
                    </div>
                  </div>
                </div>

                <h2 className="font-heading text-base font-bold text-[var(--ink)] mt-6 mb-3">
                  Follow the beat
                </h2>
                <div className="grid grid-cols-2 gap-2">
                  <a href="#" className="border border-[var(--line)] rounded-lg p-2.5 text-xs text-[var(--ink)] hover:border-[var(--accent)] text-center">
                    ◎ Instagram @drumpalaceug
                  </a>
                  <a href="#" className="border border-[var(--line)] rounded-lg p-2.5 text-xs text-[var(--ink)] hover:border-[var(--accent)] text-center">
                    f Facebook /DrumPalaceUG
                  </a>
                  <a href="#" className="border border-[var(--line)] rounded-lg p-2.5 text-xs text-[var(--ink)] hover:border-[var(--accent)] text-center">
                    ▶ TikTok @drumpalaceug
                  </a>
                  <a href="#" className="border border-[var(--line)] rounded-lg p-2.5 text-xs text-[var(--ink)] hover:border-[var(--accent)] text-center">
                    ◉ YouTube @DrumPalaceUG
                  </a>
                </div>
              </aside>

              {/* Message Panel */}
              <div className="lg:col-span-7 bg-[var(--surface)] border border-[var(--line)] rounded-2xl p-6 sm:p-7 shadow-sm">
                <h2 className="font-heading text-lg font-bold text-[var(--ink)] mb-4">
                  Send us a message
                </h2>

                <form onSubmit={handleContactSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-[var(--ink)] mb-1" htmlFor="contactName">
                      Your name
                    </label>
                    <input
                      id="contactName"
                      type="text"
                      required
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                      placeholder="Your full name"
                      className="w-full border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] rounded-lg p-3 text-sm outline-none focus:border-[var(--accent)]"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[var(--ink)] mb-1" htmlFor="contactEmail">
                      Email address
                    </label>
                    <input
                      id="contactEmail"
                      type="email"
                      required
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] rounded-lg p-3 text-sm outline-none focus:border-[var(--accent)]"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[var(--ink)] mb-1" htmlFor="contactTopic">
                      What can we help with?
                    </label>
                    <input
                      id="contactTopic"
                      type="text"
                      required
                      value={contactTopic}
                      onChange={(e) => setContactTopic(e.target.value)}
                      placeholder="Order, product, delivery…"
                      className="w-full border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] rounded-lg p-3 text-sm outline-none focus:border-[var(--accent)]"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[var(--ink)] mb-1" htmlFor="contactMessage">
                      Message
                    </label>
                    <textarea
                      id="contactMessage"
                      required
                      rows={4}
                      value={contactMessage}
                      onChange={(e) => setContactMessage(e.target.value)}
                      placeholder="Tell us how we can help."
                      className="w-full border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] rounded-lg p-3 text-sm outline-none focus:border-[var(--accent)] resize-y min-h-[120px]"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full rounded-lg bg-[var(--accent)] py-3.5 text-sm font-bold text-white hover:opacity-90 transition cursor-pointer"
                  >
                    Send message
                  </button>

                  {contactStatus && (
                    <p className="text-center text-xs text-[var(--accent)] font-semibold pt-2">
                      {contactStatus}
                    </p>
                  )}
                </form>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 9: WISHLIST VIEW */}
        {route === 'wishlist' && (
          <div className="shell py-4 sm:py-6">
            <div className="flex items-center justify-between mb-4 sm:mb-6">
              <div>
                <p className="text-[10px] sm:text-[11px] font-bold tracking-[1.6px] text-[var(--accent)] uppercase mb-0.5 sm:mb-1">YOUR SAVED GEAR</p>
                <h1 className="font-heading text-xl sm:text-2xl md:text-3xl font-bold text-[var(--ink)]">My Wishlist</h1>
              </div>
              <button
                onClick={() => navigateTo('shop')}
                className="text-xs sm:text-sm font-semibold text-[var(--accent)] hover:underline cursor-pointer"
              >
                Continue shopping →
              </button>
            </div>

            {wish.size === 0 ? (
              <div className="border border-dashed border-[var(--line)] rounded-2xl p-8 sm:p-12 text-center text-[var(--muted)]">
                <i className="text-3xl sm:text-4xl text-[var(--accent)] not-italic block mb-3">♡</i>
                <h2 className="text-base sm:text-lg font-bold text-[var(--ink)] mb-1">Your wishlist is empty</h2>
                <p className="text-xs sm:text-sm text-[var(--muted)] mb-4">Tap the heart on any product to save it for later.</p>
                <button
                  onClick={() => navigateTo('shop')}
                  className="rounded-xl border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white px-5 py-2.5 text-xs font-bold transition cursor-pointer"
                >
                  Explore products
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-4">
                {products
                  .filter((p) => wish.has(p.id))
                  .map((p) => (
                    <article
                      key={p.id}
                      className="bg-[var(--surface)] border border-[var(--line)] rounded-xl overflow-hidden relative shadow-sm flex flex-col justify-between"
                    >
                      <button
                        onClick={() => toggleWishlist(p.id)}
                        aria-label="Remove from wishlist"
                        className="absolute right-2 top-2 z-10 h-7 w-7 sm:h-8 sm:w-8 rounded-full bg-[var(--surface)]/80 backdrop-blur-sm text-base sm:text-lg flex items-center justify-center text-[#e04e5c]"
                      >
                        ♥
                      </button>

                      <div 
                        className="relative aspect-[1.18] w-full overflow-hidden bg-[var(--surface-2)] cursor-pointer"
                        onClick={() => openProductDetail(p.id)}
                      >
                        <Image
                          src={p.image}
                          alt={p.name}
                          fill
                          referrerPolicy="no-referrer"
                          className="object-cover"
                        />
                      </div>

                      <div className="p-2.5 sm:p-3 flex-1 flex flex-col justify-between">
                        <div>
                          <h3 
                            onClick={() => openProductDetail(p.id)}
                            className="text-xs sm:text-sm font-bold text-[var(--ink)] mb-0.5 cursor-pointer hover:text-[var(--accent)] line-clamp-1"
                          >
                            {p.name}
                          </h3>
                          <p className="text-[13px] sm:text-[15px] font-bold text-[var(--accent)] mb-2.5">
                            {formatMoney(p.price)}
                          </p>
                        </div>

                        <div className="flex gap-1.5 sm:gap-2">
                          <button
                            onClick={() => addToCart(p.id, 1)}
                            className="flex-1 rounded-md bg-[var(--accent)] text-white text-[11px] sm:text-xs font-semibold py-1.5 sm:py-2 hover:opacity-90 cursor-pointer"
                          >
                            Add to Cart
                          </button>
                          <button
                            onClick={() => openProductDetail(p.id)}
                            className="rounded-md border border-[var(--line)] text-[var(--ink)] text-[11px] sm:text-xs font-semibold px-2 sm:px-2.5 py-1.5 sm:py-2 hover:bg-[var(--surface-2)] cursor-pointer"
                          >
                            View
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* VIEW: USER ACCOUNT PROFILE & TRANSACTION HISTORY */}
        {(route === 'account' || route === 'profile' || (route === 'login' && currentUser)) && (
          <AccountProfileView
            currentUser={currentUser}
            onBack={() => navigateTo('home')}
            onNavigate={navigateTo}
            onSignOut={handleSignOut}
            onOpenAdmin={openAdminPortal}
            currency={currency}
            wishlistCount={wish.size}
            cartCount={totalCartCount}
            onProfileUpdated={(updated) => {
              setCurrentUser(updated);
            }}
          />
        )}
        {/* VIEW 10: SETTINGS VIEW */}
        {route === 'settings' && (
          <SettingsView
            onBack={() => navigateTo('home')}
            isDarkMode={isDarkMode}
            onToggleTheme={toggleTheme}
            currentUser={currentUser}
            onSignOut={handleSignOut}
            onNavigate={navigateTo}
            cartCount={totalCartCount}
            wishlistCount={wish.size}
            onOpenDrawer={() => setIsDrawerOpen(true)}
            onOpenAdmin={() => setShowAdminPortal(true)}
          />
        )}

        {/* VIEW 11: TRACK ORDER / MY ORDERS */}
        {(route === 'track-order' || route === 'orders') && (
          <TrackOrderView
            onBack={() => navigateTo('home')}
            onNavigate={navigateTo}
          />
        )}

        {/* VIEW 12: ALL CATEGORIES */}
        {route === 'categories' && (
          <CategoriesView
            onBack={() => navigateTo('home')}
            onSelectCategory={(catId) => {
              setFilter(catId);
              setSearchQuery('');
              navigateTo('shop');
            }}
            categories={categories}
            productsCountByCat={productsCountByCat}
          />
        )}

        {/* VIEW 13: FAQS */}
        {route === 'faqs' && (
          <FAQsView onBack={() => navigateTo('home')} />
        )}

        {/* VIEW 14: SHIPPING & RETURNS */}
        {route === 'shipping' && (
          <ShippingReturnsView onBack={() => navigateTo('home')} />
        )}

        {/* VIEW 15: ABOUT US */}
        {route === 'about' && (
          <AboutUsView onBack={() => navigateTo('home')} onNavigate={navigateTo} />
        )}
      </main>

      {/* ========================================================= */}
      {/* MOBILE BOTTOM NAVIGATION BAR (Phones & Small Tablets) */}
      {/* ========================================================= */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[var(--surface)]/95 backdrop-blur-lg border-t border-[var(--line)] px-2 py-1.5 flex items-center justify-around shadow-[0_-4px_20px_rgba(0,0,0,0.08)]">
        <button
          onClick={() => navigateTo('home')}
          className={`flex flex-col items-center justify-center min-w-[50px] py-1 text-[10px] font-semibold transition cursor-pointer ${
            route === 'home' ? 'text-[var(--accent)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }`}
        >
          <span className="text-base leading-none mb-0.5">🏠</span>
          <span>Home</span>
        </button>

        <button
          onClick={() => {
            setFilter('all');
            setSearchQuery('');
            navigateTo('shop');
          }}
          className={`flex flex-col items-center justify-center min-w-[50px] py-1 text-[10px] font-semibold transition cursor-pointer ${
            route === 'shop' ? 'text-[var(--accent)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }`}
        >
          <span className="text-base leading-none mb-0.5">🎸</span>
          <span>Shop</span>
        </button>

        <button
          onClick={() => navigateTo('wishlist')}
          className={`relative flex flex-col items-center justify-center min-w-[50px] py-1 text-[10px] font-semibold transition cursor-pointer ${
            route === 'wishlist' ? 'text-[var(--accent)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }`}
        >
          <span className="text-base leading-none mb-0.5">♡</span>
          <span>Saved</span>
          {wish.size > 0 && (
            <span className="absolute top-0 right-2 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#e04e5c] text-[8px] font-bold text-white">
              {wish.size}
            </span>
          )}
        </button>

        <button
          onClick={() => navigateTo('cart')}
          className={`relative flex flex-col items-center justify-center min-w-[50px] py-1 text-[10px] font-semibold transition cursor-pointer ${
            route === 'cart' ? 'text-[var(--accent)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }`}
        >
          <span className="text-base leading-none mb-0.5">🛒</span>
          <span>Cart</span>
          {totalCartCount > 0 && (
            <span className="absolute top-0 right-2 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--accent)] text-[8px] font-bold text-white">
              {totalCartCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setIsDrawerOpen(true)}
          className={`flex flex-col items-center justify-center min-w-[50px] py-1 text-[10px] font-semibold transition cursor-pointer text-[var(--muted)] hover:text-[var(--ink)]`}
        >
          <span className="text-base leading-none mb-0.5">☰</span>
          <span>Menu</span>
        </button>

        <button
          onClick={() => navigateTo(currentUser ? 'account' : 'login')}
          className={`flex flex-col items-center justify-center min-w-[56px] py-1 text-[10px] font-semibold transition cursor-pointer ${
            route === 'login' || route === 'register' || route === 'account' || route === 'profile' ? 'text-[var(--accent)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }`}
        >
          <span className="text-lg leading-none mb-0.5">👤</span>
          <span>{currentUser ? 'Account' : 'Sign In'}</span>
        </button>
      </nav>

      {/* ========================================================= */}
      {/* FOOTER */}
      {/* ========================================================= */}
      <footer className="border-t border-[var(--line)] py-8 px-4 text-xs text-[var(--muted)] bg-[var(--surface)] pb-24 md:pb-8">
        <div className="shell flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <DrumPalaceLogo size={70} />
            <p>© 2026 {storeSettings.storeName || 'Drum Palace'} · {storeSettings.storeTagline || 'All About Quality'} · Uganda</p>
          </div>
          <div className="flex items-center gap-4 sm:gap-5 flex-wrap justify-center font-medium">
            <button onClick={() => navigateTo('home')} className="hover:text-[var(--accent)] transition cursor-pointer">Home</button>
            <button onClick={() => navigateTo('shop')} className="hover:text-[var(--accent)] transition cursor-pointer">Shop</button>
            <button onClick={() => navigateTo('categories')} className="hover:text-[var(--accent)] transition cursor-pointer">Categories</button>
            <button onClick={() => navigateTo('track-order')} className="hover:text-[var(--accent)] transition cursor-pointer">Track Order</button>
            <button onClick={() => navigateTo('shipping')} className="hover:text-[var(--accent)] transition cursor-pointer">Shipping</button>
            <button onClick={() => navigateTo('faqs')} className="hover:text-[var(--accent)] transition cursor-pointer">FAQs</button>
            <button onClick={() => navigateTo('about')} className="hover:text-[var(--accent)] transition cursor-pointer">About</button>
            <button onClick={() => navigateTo('contact')} className="hover:text-[var(--accent)] transition cursor-pointer">Contact</button>
            <button onClick={() => navigateTo('settings')} className="hover:text-[var(--accent)] transition cursor-pointer">Settings</button>
            {currentUser?.role === 'admin' ? (
              <button onClick={openAdminPortal} className="text-[var(--accent)] font-semibold cursor-pointer flex items-center gap-1">
                <span>⚙️</span> Admin Dashboard
              </button>
            ) : (
              <button onClick={openAdminPortal} className="text-[var(--muted)] hover:text-[var(--accent)] text-[11px] font-medium cursor-pointer flex items-center gap-1">
                <span>🔒</span> Staff Access
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
