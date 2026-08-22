import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { formatPrice, getSavedCurrency, CurrencyCode } from "./currency"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatMoney(amount: number, customCurrency?: CurrencyCode | string): string {
  if (amount === undefined || amount === null || isNaN(amount)) return "UGX 0";
  // Standardize amount to UGX base:
  const ugxVal = amount < 10000 && amount > 0 ? Math.round(amount * 3750) : Math.round(amount);
  const cur = (customCurrency as CurrencyCode) || getSavedCurrency();
  return formatPrice(ugxVal, cur);
}

