import { supabase } from './supabase';

export interface BannerSlide {
  id: string;
  image: string;
  caption: string;
  subtext?: string;
  ctaText?: string;
  categoryFilter?: string;
}

export interface HotDealItem {
  id: string;
  productId: string;
  customTitle?: string;
  customImage?: string;
  discountPercent: number;
  customBadge?: string;
  active: boolean;
  customPrice?: number;
  originalPrice?: number;
}

export interface StoreSettings {
  storeName: string;
  storeTagline: string;
  announcementText: string;
  announcementActive: boolean;
  heroHeadline: string;
  heroSubtitle: string;
  heroBadge: string;
  heroButtonText: string;
  contactPhone: string;
  contactWhatsapp: string;
  contactEmail: string;
  contactAddress: string;
  freeShippingThreshold: number;
  bannerSlides?: BannerSlide[];
  hotDeals?: HotDealItem[];
}

export const DEFAULT_HOT_DEALS: HotDealItem[] = [
  {
    id: 'deal-1',
    productId: 'g-1',
    customTitle: "Custom Stratocaster HSS '60s Vintage",
    customImage: "https://images.unsplash.com/photo-1564186763535-ebb21ef5277f?auto=format&fit=crop&w=1200&q=90",
    discountPercent: 20,
    customBadge: "20% OFF FLASH",
    active: true,
    customPrice: 1759000,
    originalPrice: 2199000
  },
  {
    id: 'deal-2',
    productId: 'd-1',
    customTitle: "Artisan Drum Craft Studio 5-Piece Shell Pack",
    customImage: "https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=1200&q=90",
    discountPercent: 25,
    customBadge: "25% OFF SPECIAL",
    active: true,
    customPrice: 2400000,
    originalPrice: 3200000
  },
  {
    id: 'deal-3',
    productId: 'k-2',
    customTitle: "Analog PolySynth 8 Voice Desktop Matrix",
    customImage: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?auto=format&fit=crop&w=1200&q=90",
    discountPercent: 18,
    customBadge: "18% OFF DEAL",
    active: true,
    customPrice: 1967000,
    originalPrice: 2399000
  },
  {
    id: 'deal-4',
    productId: 'd-3',
    customTitle: "Heritage Hand-Hammered Cymbal Master Set",
    customImage: "https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=1200&q=90",
    discountPercent: 30,
    customBadge: "30% OFF COMBO",
    active: true,
    customPrice: 1119000,
    originalPrice: 1599000
  },
  {
    id: 'deal-5',
    productId: 's-1',
    customTitle: "Vintage Tube Studio Condenser Microphone",
    customImage: "https://images.unsplash.com/photo-1590602847861-f357a9332bbc?auto=format&fit=crop&w=1200&q=90",
    discountPercent: 22,
    customBadge: "22% OFF PRO AUDIO",
    active: true,
    customPrice: 1443000,
    originalPrice: 1850000
  },
  {
    id: 'deal-6',
    productId: 'g-6',
    customTitle: "Classic Telecaster Custom Ash Body",
    customImage: "https://images.unsplash.com/photo-1525201548942-d8732f6617a0?auto=format&fit=crop&w=1200&q=90",
    discountPercent: 15,
    customBadge: "15% OFF",
    active: true,
    customPrice: 1699000,
    originalPrice: 1999000
  },
  {
    id: 'deal-7',
    productId: 'd-5',
    customTitle: "Drum Palace Pro Mesh Electronic Drum Flagship",
    customImage: "https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=1200&q=90",
    discountPercent: 20,
    customBadge: "20% OFF",
    active: true,
    customPrice: 2399000,
    originalPrice: 2999000
  },
  {
    id: 'deal-8',
    productId: 'k-8',
    customTitle: "FM Digital Synth & Rhythm Groovebox",
    customImage: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?auto=format&fit=crop&w=1200&q=90",
    discountPercent: 16,
    customBadge: "16% OFF HOT",
    active: true,
    customPrice: 798000,
    originalPrice: 950000
  }
];

export const DEFAULT_BANNER_SLIDES: BannerSlide[] = [];

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  storeName: "Drum Palace",
  storeTagline: "All About Quality",
  announcementText: "Free Express Delivery on all Pro Audio & Instrument Orders across Uganda • Same-Day Dispatch in Kampala",
  announcementActive: true,
  heroHeadline: "Crafted for Pure Acoustic Power & Stage Precision",
  heroSubtitle: "Handcrafted drum sets, custom-voiced guitars, digital keyboards and tour-grade sound systems engineered for musicians, churches, and live stages.",
  heroBadge: "New Season 2026 Collection",
  heroButtonText: "Explore Complete Catalog",
  contactPhone: "+256 700 123 456",
  contactWhatsapp: "+256 700 123 456",
  contactEmail: "info@drumpalace.ug",
  contactAddress: "Plot 14, Kampala Road, Music District, Kampala, Uganda",
  freeShippingThreshold: 500000,
  bannerSlides: DEFAULT_BANNER_SLIDES,
  hotDeals: DEFAULT_HOT_DEALS,
};

let cachedSettingsSnapshot: StoreSettings = DEFAULT_STORE_SETTINGS;
let isFetchedFromDb = false;

export function subscribeStoreSettings(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => callback();
  window.addEventListener("store_settings_updated", handler);
  return () => {
    window.removeEventListener("store_settings_updated", handler);
  };
}

export function getStoreSettingsSnapshot(): StoreSettings {
  if (typeof window === "undefined") return DEFAULT_STORE_SETTINGS;
  
  if (!isFetchedFromDb) {
    isFetchedFromDb = true;
    fetchStoreSettingsFromDb().then((dbSettings) => {
      if (dbSettings) {
        cachedSettingsSnapshot = { ...DEFAULT_STORE_SETTINGS, ...dbSettings };
        window.dispatchEvent(new CustomEvent("store_settings_updated", { detail: cachedSettingsSnapshot }));
      }
    });
  }
  return cachedSettingsSnapshot;
}

export function getStoreSettingsServerSnapshot(): StoreSettings {
  return DEFAULT_STORE_SETTINGS;
}

export function getStoreSettings(): StoreSettings {
  return getStoreSettingsSnapshot();
}

/**
 * Fetch store settings directly from the database table store_settings
 */
export async function fetchStoreSettingsFromDb(): Promise<StoreSettings | null> {
  try {
    const { data, error } = await (supabase.from('store_settings') as any)
      .select('*')
      .eq('id', 'default_settings')
      .maybeSingle();

    if (!error && data?.settings) {
      return data.settings as StoreSettings;
    }
  } catch (err) {
    console.error('Error reading store_settings from database:', err);
  }
  return null;
}

/**
 * Save store settings directly into the database table store_settings
 */
export async function saveStoreSettings(settings: StoreSettings): Promise<boolean> {
  cachedSettingsSnapshot = { ...DEFAULT_STORE_SETTINGS, ...settings };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("store_settings_updated", { detail: cachedSettingsSnapshot }));
  }

  try {
    const { error } = await (supabase.from('store_settings') as any).upsert({
      id: 'default_settings',
      settings,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error("Error writing store settings to database:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Database store settings write exception:", e);
    return false;
  }
}

