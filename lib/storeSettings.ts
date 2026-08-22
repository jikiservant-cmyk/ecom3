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

export const DEFAULT_HOT_DEALS: HotDealItem[] = [];

export const DEFAULT_BANNER_SLIDES: BannerSlide[] = [];

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  storeName: "Drum Palace",
  storeTagline: "All About Quality",
  announcementText: "",
  announcementActive: false,
  heroHeadline: "",
  heroSubtitle: "",
  heroBadge: "",
  heroButtonText: "",
  contactPhone: "",
  contactWhatsapp: "",
  contactEmail: "",
  contactAddress: "",
  freeShippingThreshold: 500000,
  bannerSlides: [],
  hotDeals: [],
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
    const now = new Date().toISOString();

    const { data: existingRow } = await (supabase.from('store_settings') as any)
      .select('id')
      .eq('id', 'default_settings')
      .maybeSingle();

    let error = null;

    if (existingRow) {
      const res = await (supabase.from('store_settings') as any).update({
        key: 'default',
        value: settings,
        settings: settings,
        updated_at: now,
      }).eq('id', 'default_settings');
      error = res.error;
    } else {
      const res = await (supabase.from('store_settings') as any).insert({
        id: 'default_settings',
        key: 'default',
        value: settings,
        settings: settings,
        created_at: now,
        updated_at: now,
      });
      error = res.error;
    }

    if (error) {
      console.error("Error writing store settings to database:", error);
      if (typeof window !== "undefined") {
        alert("Failed to save settings to the database!\n\nThis is likely because the Row Level Security (RLS) policies for the 'store_settings' table are missing in your Supabase project.\n\nPlease go to the 'Cloud Sync' tab in the Admin Portal, click 'Copy Complete SQL Schema', and run that SQL in your Supabase SQL Editor to fix the permissions.");
      }
      return false;
    }
    return true;
  } catch (e) {
    console.error("Database store settings write exception:", e);
    return false;
  }
}

