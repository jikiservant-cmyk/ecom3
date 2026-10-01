import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { formatPrice, getSavedCurrency, CurrencyCode } from "./currency"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatMoney(amount: number, customCurrency?: CurrencyCode | string): string {
  if (amount === undefined || amount === null || isNaN(amount)) return "UGX 0";
  // SECURITY/CORRECTNESS: all app amounts are UGX. The previous heuristic
  // multiplied any value under 10,000 by 3,750, silently distorting prices.
  const ugxVal = Math.round(amount);
  const cur = (customCurrency as CurrencyCode) || getSavedCurrency();
  return formatPrice(ugxVal, cur);
}

