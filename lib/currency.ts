export type CurrencyCode = 'UGX' | 'USD' | 'GBP' | 'EUR' | 'KES';

export interface CurrencyConfig {
  code: CurrencyCode;
  name: string;
  symbol: string;
  flag: string;
  rateFromUGX: number; // multiplier from UGX base
  format: (val: number) => string;
}

export const CURRENCIES: Record<CurrencyCode, CurrencyConfig> = {
  UGX: {
    code: 'UGX',
    name: 'Ugandan Shilling',
    symbol: 'UGX',
    flag: '🇺🇬',
    rateFromUGX: 1,
    format: (val: number) => `UGX ${Math.round(val).toLocaleString()}`,
  },
  USD: {
    code: 'USD',
    name: 'US Dollar',
    symbol: '$',
    flag: '🇺🇸',
    rateFromUGX: 1 / 3750,
    format: (val: number) => `$${(val / 3750).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  },
  GBP: {
    code: 'GBP',
    name: 'British Pound',
    symbol: '£',
    flag: '🇬🇧',
    rateFromUGX: 1 / 4800,
    format: (val: number) => `£${(val / 4800).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  },
  EUR: {
    code: 'EUR',
    name: 'Euro',
    symbol: '€',
    flag: '🇪🇺',
    rateFromUGX: 1 / 4100,
    format: (val: number) => `€${(val / 4100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  },
  KES: {
    code: 'KES',
    name: 'Kenyan Shilling',
    symbol: 'KES',
    flag: '🇰🇪',
    rateFromUGX: 1 / 29,
    format: (val: number) => `KES ${Math.round(val / 29).toLocaleString()}`,
  },
};

const STORAGE_KEY = 'drumpalace_currency_v1';

let cachedCurrencySnapshot: CurrencyCode = 'UGX';
let lastRawCurrency: string | null = null;

export function subscribeCurrency(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => callback();
  window.addEventListener('currency_updated', handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener('currency_updated', handler);
    window.removeEventListener('storage', handler);
  };
}

export function getCurrencySnapshot(): CurrencyCode {
  if (typeof window === 'undefined') return 'UGX';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== lastRawCurrency) {
      lastRawCurrency = saved;
      cachedCurrencySnapshot = (saved && saved in CURRENCIES) ? (saved as CurrencyCode) : 'UGX';
    }
  } catch {
    return cachedCurrencySnapshot;
  }
  return cachedCurrencySnapshot;
}

export function getCurrencyServerSnapshot(): CurrencyCode {
  return 'UGX';
}

export function getSavedCurrency(): CurrencyCode {
  return getCurrencySnapshot();
}

export function saveCurrency(code: CurrencyCode): void {
  if (typeof window === 'undefined') return;
  try {
    lastRawCurrency = code;
    cachedCurrencySnapshot = code;
    localStorage.setItem(STORAGE_KEY, code);
    window.dispatchEvent(new CustomEvent('currency_updated', { detail: code }));
  } catch (e) {
    console.error(e);
  }
}

export function formatPrice(priceInUGX: number, currency: CurrencyCode = 'UGX'): string {
  const conf = CURRENCIES[currency] || CURRENCIES.UGX;
  return conf.format(priceInUGX);
}
