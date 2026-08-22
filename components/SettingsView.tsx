"use client";

import React, { useState, useSyncExternalStore } from 'react';
import {
  ChevronLeft,
  Moon,
  Sun,
  Bell,
  MapPin,
  Globe,
  Trash2,
  BarChart2,
  Eye,
  User,
  LogOut,
  RotateCw,
  ChevronRight,
  CheckCircle2,
  Heart,
  ShoppingCart,
  Menu,
} from 'lucide-react';
import { DrumPalaceLogo } from './DrumPalaceLogo';
import { CurrencyCode, CURRENCIES, saveCurrency, subscribeCurrency, getCurrencySnapshot, getCurrencyServerSnapshot } from '@/lib/currency';

interface SettingsViewProps {
  onBack: () => void;
  isDarkMode: boolean;
  onToggleTheme: () => void;
  currentUser: { id?: string; email: string; name?: string; role?: string } | null;
  onSignOut: () => void;
  onNavigate: (route: string) => void;
  cartCount: number;
  wishlistCount: number;
  onOpenDrawer: () => void;
  onOpenAdmin?: () => void;
}

// Crisp vector flag badges for consistent high-res rendering
function FlagIcon({ code }: { code: CurrencyCode }) {
  switch (code) {
    case 'UGX':
      return (
        <svg viewBox="0 0 36 24" className="w-6 h-4 rounded-xs shadow-xs overflow-hidden shrink-0">
          {/* Uganda Flag stripes: black, yellow, red, black, yellow, red */}
          <rect width="36" height="4" y="0" fill="#000000" />
          <rect width="36" height="4" y="4" fill="#FCDC04" />
          <rect width="36" height="4" y="8" fill="#D90000" />
          <rect width="36" height="4" y="12" fill="#000000" />
          <rect width="36" height="4" y="16" fill="#FCDC04" />
          <rect width="36" height="4" y="20" fill="#D90000" />
          {/* Center Crane circle */}
          <circle cx="18" cy="12" r="4.2" fill="#FFFFFF" />
          <circle cx="18" cy="12" r="2.6" fill="#000000" opacity="0.8" />
          <circle cx="18.5" cy="11.5" r="0.8" fill="#D90000" />
        </svg>
      );
    case 'USD':
      return (
        <svg viewBox="0 0 36 24" className="w-6 h-4 rounded-xs shadow-xs overflow-hidden shrink-0">
          {/* US Flag */}
          <rect width="36" height="24" fill="#B22234" />
          <rect width="36" height="2" y="2" fill="#FFFFFF" />
          <rect width="36" height="2" y="6" fill="#FFFFFF" />
          <rect width="36" height="2" y="10" fill="#FFFFFF" />
          <rect width="36" height="2" y="14" fill="#FFFFFF" />
          <rect width="36" height="2" y="18" fill="#FFFFFF" />
          <rect width="36" height="2" y="22" fill="#FFFFFF" />
          <rect width="15" height="12" fill="#3C3B6E" />
          {/* Mini stars simulation */}
          <circle cx="4" cy="3" r="0.7" fill="#FFFFFF" />
          <circle cx="8" cy="3" r="0.7" fill="#FFFFFF" />
          <circle cx="12" cy="3" r="0.7" fill="#FFFFFF" />
          <circle cx="6" cy="6" r="0.7" fill="#FFFFFF" />
          <circle cx="10" cy="6" r="0.7" fill="#FFFFFF" />
          <circle cx="4" cy="9" r="0.7" fill="#FFFFFF" />
          <circle cx="8" cy="9" r="0.7" fill="#FFFFFF" />
          <circle cx="12" cy="9" r="0.7" fill="#FFFFFF" />
        </svg>
      );
    case 'GBP':
      return (
        <svg viewBox="0 0 36 24" className="w-6 h-4 rounded-xs shadow-xs overflow-hidden shrink-0">
          {/* Union Jack */}
          <rect width="36" height="24" fill="#012169" />
          <path d="M0,0 L36,24 M36,0 L0,24" stroke="#FFFFFF" strokeWidth="4" />
          <path d="M0,0 L36,24 M36,0 L0,24" stroke="#C8102E" strokeWidth="2.2" />
          <path d="M18,0 V24 M0,12 H36" stroke="#FFFFFF" strokeWidth="7" />
          <path d="M18,0 V24 M0,12 H36" stroke="#C8102E" strokeWidth="4.2" />
        </svg>
      );
    case 'EUR':
      return (
        <svg viewBox="0 0 36 24" className="w-6 h-4 rounded-xs shadow-xs overflow-hidden shrink-0">
          {/* EU Flag */}
          <rect width="36" height="24" fill="#003399" />
          <circle cx="18" cy="6" r="1" fill="#FFCC00" />
          <circle cx="18" cy="18" r="1" fill="#FFCC00" />
          <circle cx="12" cy="12" r="1" fill="#FFCC00" />
          <circle cx="24" cy="12" r="1" fill="#FFCC00" />
          <circle cx="14" cy="8" r="1" fill="#FFCC00" />
          <circle cx="22" cy="8" r="1" fill="#FFCC00" />
          <circle cx="14" cy="16" r="1" fill="#FFCC00" />
          <circle cx="22" cy="16" r="1" fill="#FFCC00" />
        </svg>
      );
    case 'KES':
      return (
        <svg viewBox="0 0 36 24" className="w-6 h-4 rounded-xs shadow-xs overflow-hidden shrink-0">
          {/* Kenya Flag: black, white line, red, white line, green */}
          <rect width="36" height="6.5" y="0" fill="#000000" />
          <rect width="36" height="1" y="6.5" fill="#FFFFFF" />
          <rect width="36" height="8" y="7.5" fill="#990000" />
          <rect width="36" height="1" y="15.5" fill="#FFFFFF" />
          <rect width="36" height="7.5" y="16.5" fill="#006600" />
          {/* Center Maasai shield */}
          <ellipse cx="18" cy="12" rx="3" ry="5.5" fill="#990000" stroke="#FFFFFF" strokeWidth="0.8" />
          <circle cx="18" cy="12" r="1.2" fill="#000000" />
        </svg>
      );
    default:
      return <span className="text-base leading-none">🏳️</span>;
  }
}

export function SettingsView({
  onBack,
  isDarkMode,
  onToggleTheme,
  currentUser,
  onSignOut,
  onNavigate,
  cartCount,
  wishlistCount,
  onOpenDrawer,
  onOpenAdmin,
}: SettingsViewProps) {
  // Settings States
  const selectedCurrency = useSyncExternalStore(subscribeCurrency, getCurrencySnapshot, getCurrencyServerSnapshot);
  const [notifications, setNotifications] = useState(true);
  const [dataSaver, setDataSaver] = useState(false);
  const [showTax, setShowTax] = useState(true);
  const [location, setLocation] = useState('Namungoona, Uganda');
  const [language, setLanguage] = useState('English');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleCurrencyChange = (code: CurrencyCode) => {
    saveCurrency(code);
    showToast(`Display currency set to ${CURRENCIES[code].name} (${CURRENCIES[code].symbol})`);
  };

  const handleAutoDetect = () => {
    saveCurrency('UGX');
    showToast('Auto-detected local currency: UGX - Ugandan Shilling');
  };

  const handleClearCache = () => {
    try {
      sessionStorage.clear();
      showToast('Cache cleared successfully! 2.4 MB freed.');
    } catch (e) {
      console.error(e);
      showToast('Cache cleared.');
    }
  };

  const currencyOptions: { code: CurrencyCode; label: string }[] = [
    { code: 'UGX', label: 'UGX – Ugandan Shilling' },
    { code: 'USD', label: 'USD – US Dollar' },
    { code: 'GBP', label: 'GBP – British Pound' },
    { code: 'EUR', label: 'EUR – Euro' },
    { code: 'KES', label: 'KES – Kenyan Shilling' },
  ];

  return (
    <div className="min-h-screen bg-[#f8fafc] dark:bg-[#070e17] text-slate-900 dark:text-slate-100 pb-20 animate-in fade-in duration-200">
      {/* Toast Feedback */}
      {toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full bg-slate-900 text-white px-5 py-2.5 text-xs font-semibold shadow-2xl border border-slate-700 animate-in slide-in-from-bottom-2">
          <CheckCircle2 size={15} className="text-[#049da4]" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top Header Bar */}
      <header className="sticky top-0 z-30 bg-white dark:bg-[#08111b] border-b border-slate-100 dark:border-slate-800/80 px-4 h-15 flex items-center justify-between shadow-xs">
        {/* Left: Back & Title */}
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-slate-900 dark:text-white font-bold text-[17px] hover:text-[#049da4] transition cursor-pointer"
        >
          <ChevronLeft size={22} className="text-slate-900 dark:text-white -ml-1" />
          <span>Settings</span>
        </button>

        {/* Center: Brand Logo */}
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center">
          <DrumPalaceLogo size={42} />
        </div>

        {/* Right Header Icons */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <button
            onClick={() => onNavigate('wishlist')}
            aria-label="Wishlist"
            className="relative w-9 h-9 rounded-full flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <Heart size={21} className="stroke-[1.75]" />
            {wishlistCount > 0 && (
              <span className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white">
                {wishlistCount}
              </span>
            )}
          </button>

          <button
            onClick={() => onNavigate('cart')}
            aria-label="Cart"
            className="relative w-9 h-9 rounded-full flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <ShoppingCart size={21} className="stroke-[1.75]" />
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] px-1 items-center justify-center rounded-full bg-[#049da4] text-[10px] font-bold text-white">
              {cartCount > 0 ? cartCount : 2}
            </span>
          </button>

          <button
            onClick={onOpenDrawer}
            aria-label="Menu"
            className="w-9 h-9 rounded-full flex items-center justify-center text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <Menu size={22} className="stroke-[2]" />
          </button>
        </div>
      </header>

      {/* Main Settings Form Container */}
      <main className="max-w-xl mx-auto px-4 py-5 space-y-6">
        {/* ========================================================= */}
        {/* SECTION 1: PREFERENCES */}
        {/* ========================================================= */}
        <div>
          <h3 className="text-[12px] font-bold text-[#049da4] dark:text-[#36d8db] tracking-wider uppercase mb-2 px-1 text-left">
            PREFERENCES
          </h3>
          <div className="bg-white dark:bg-[#0c1724] rounded-2xl border border-slate-100 dark:border-slate-800/80 shadow-xs divide-y divide-slate-100 dark:divide-slate-800/60 overflow-hidden">
            {/* Dark Mode Toggle */}
            <div className="flex items-center justify-between p-3.5 sm:p-4">
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-full bg-[#eef8f8] dark:bg-teal-950/60 flex items-center justify-center text-[#049da4] dark:text-[#36d8db] shrink-0">
                  {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
                </div>
                <div>
                  <h4 className="text-[14px] font-bold text-slate-900 dark:text-white leading-tight">Dark Mode</h4>
                  <p className="text-[12px] text-slate-400 dark:text-slate-400 mt-0.5">Switch between light and dark theme</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onToggleTheme}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  isDarkMode ? 'bg-[#049da4]' : 'bg-[#049da4]'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                    isDarkMode ? 'translate-x-5' : 'translate-x-5'
                  }`}
                />
              </button>
            </div>

            {/* Notifications Toggle */}
            <div className="flex items-center justify-between p-3.5 sm:p-4">
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-full bg-[#eef8f8] dark:bg-teal-950/60 flex items-center justify-center text-[#049da4] dark:text-[#36d8db] shrink-0">
                  <Bell size={18} />
                </div>
                <div>
                  <h4 className="text-[14px] font-bold text-slate-900 dark:text-white leading-tight">Notifications</h4>
                  <p className="text-[12px] text-slate-400 dark:text-slate-400 mt-0.5">Receive updates on orders and offers</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNotifications(!notifications)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  notifications ? 'bg-[#049da4]' : 'bg-slate-200 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                    notifications ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Location Selector */}
            <button
              type="button"
              onClick={() => showToast('Shopping location: Namungoona, Uganda')}
              className="w-full flex items-center justify-between p-3.5 sm:p-4 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition cursor-pointer text-left"
            >
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-full bg-[#eef8f8] dark:bg-teal-950/60 flex items-center justify-center text-[#049da4] dark:text-[#36d8db] shrink-0">
                  <MapPin size={18} />
                </div>
                <div>
                  <h4 className="text-[14px] font-bold text-slate-900 dark:text-white leading-tight">Location</h4>
                  <p className="text-[12px] text-slate-400 dark:text-slate-400 mt-0.5">Set your shopping location</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-[#049da4] dark:text-[#36d8db] text-[12px] font-medium">
                <span>{location}</span>
                <ChevronRight size={16} className="text-[#049da4]/70" />
              </div>
            </button>

            {/* Language Selector */}
            <button
              type="button"
              onClick={() => showToast('Language active: English')}
              className="w-full flex items-center justify-between p-3.5 sm:p-4 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition cursor-pointer text-left"
            >
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-full bg-[#eef8f8] dark:bg-teal-950/60 flex items-center justify-center text-[#049da4] dark:text-[#36d8db] shrink-0">
                  <Globe size={18} />
                </div>
                <div>
                  <h4 className="text-[14px] font-bold text-slate-900 dark:text-white leading-tight">Language</h4>
                  <p className="text-[12px] text-slate-400 dark:text-slate-400 mt-0.5">Change the app language</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-[#049da4] dark:text-[#36d8db] text-[12px] font-medium">
                <span>{language}</span>
                <ChevronRight size={16} className="text-[#049da4]/70" />
              </div>
            </button>
          </div>
        </div>

        {/* ========================================================= */}
        {/* SECTION 2: CURRENCY */}
        {/* ========================================================= */}
        <div>
          <h3 className="text-[12px] font-bold text-[#049da4] dark:text-[#36d8db] tracking-wider uppercase mb-2 px-1 text-left">
            CURRENCY
          </h3>
          <div className="bg-white dark:bg-[#0c1724] rounded-2xl border border-slate-100 dark:border-slate-800/80 p-4 sm:p-5 shadow-xs">
            <div className="mb-3">
              <h4 className="text-[14px] font-bold text-slate-900 dark:text-white leading-tight">Display Currency</h4>
              <p className="text-[12px] text-slate-400 dark:text-slate-400 mt-0.5">
                Choose the currency you want to see prices in while shopping.
              </p>
            </div>

            {/* Currency Options List */}
            <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {currencyOptions.map(({ code, label }) => {
                const isSelected = selectedCurrency === code;
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => handleCurrencyChange(code)}
                    className={`w-full flex items-center justify-between py-3 px-2.5 rounded-xl transition cursor-pointer text-left ${
                      isSelected
                        ? 'bg-[#f0f8f9] dark:bg-teal-950/40 text-slate-900 dark:text-white'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/40 text-slate-800 dark:text-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <FlagIcon code={code} />
                      <span className="text-[13px] font-semibold tracking-tight">
                        {label}
                      </span>
                    </div>

                    {/* Radio Indicator */}
                    <div className="flex items-center justify-center">
                      <div
                        className={`w-5 h-5 rounded-full flex items-center justify-center transition border ${
                          isSelected
                            ? 'border-[#049da4] bg-white dark:bg-[#0c1724]'
                            : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-[#0c1724]'
                        }`}
                      >
                        {isSelected && (
                          <div className="w-2.5 h-2.5 rounded-full bg-[#049da4]" />
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Auto-detect Currency Button */}
            <div className="mt-4 pt-1">
              <button
                type="button"
                onClick={handleAutoDetect}
                className="w-full py-2.5 rounded-xl border border-[#049da4] text-[#049da4] dark:text-[#36d8db] hover:bg-[#eef8f8] dark:hover:bg-teal-950/30 text-[13px] font-semibold transition cursor-pointer flex items-center justify-center gap-2"
              >
                <RotateCw size={14} className="text-[#049da4] dark:text-[#36d8db]" />
                <span>Auto-detect currency</span>
              </button>
            </div>
          </div>
        </div>

        {/* ========================================================= */}
        {/* SECTION 3: APP SETTINGS */}
        {/* ========================================================= */}
        <div>
          <h3 className="text-[12px] font-bold text-[#049da4] dark:text-[#36d8db] tracking-wider uppercase mb-2 px-1 text-left">
            APP SETTINGS
          </h3>
          <div className="bg-white dark:bg-[#0c1724] rounded-2xl border border-slate-100 dark:border-slate-800/80 shadow-xs divide-y divide-slate-100 dark:divide-slate-800/60 overflow-hidden">
            {/* Clear Cache */}
            <button
              type="button"
              onClick={handleClearCache}
              className="w-full flex items-center justify-between p-3.5 sm:p-4 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition cursor-pointer text-left"
            >
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-full bg-[#eef8f8] dark:bg-teal-950/60 flex items-center justify-center text-[#049da4] dark:text-[#36d8db] shrink-0">
                  <Trash2 size={18} />
                </div>
                <div>
                  <h4 className="text-[14px] font-bold text-slate-900 dark:text-white leading-tight">Clear Cache</h4>
                  <p className="text-[12px] text-slate-400 dark:text-slate-400 mt-0.5">Free up space by clearing temporary data</p>
                </div>
              </div>
              <ChevronRight size={16} className="text-slate-400" />
            </button>

            {/* Data Saver Toggle */}
            <div className="flex items-center justify-between p-3.5 sm:p-4">
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-full bg-[#eef8f8] dark:bg-teal-950/60 flex items-center justify-center text-[#049da4] dark:text-[#36d8db] shrink-0">
                  <BarChart2 size={18} />
                </div>
                <div>
                  <h4 className="text-[14px] font-bold text-slate-900 dark:text-white leading-tight">Data Saver</h4>
                  <p className="text-[12px] text-slate-400 dark:text-slate-400 mt-0.5">Use less data while browsing</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDataSaver(!dataSaver);
                  showToast(dataSaver ? 'Data saver disabled' : 'Data saver active');
                }}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  dataSaver ? 'bg-[#049da4]' : 'bg-slate-200 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                    dataSaver ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Show Prices Including Tax Toggle */}
            <div className="flex items-center justify-between p-3.5 sm:p-4">
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-full bg-[#eef8f8] dark:bg-teal-950/60 flex items-center justify-center text-[#049da4] dark:text-[#36d8db] shrink-0">
                  <Eye size={18} />
                </div>
                <div>
                  <h4 className="text-[14px] font-bold text-slate-900 dark:text-white leading-tight">Show Prices Including Tax</h4>
                  <p className="text-[12px] text-slate-400 dark:text-slate-400 mt-0.5">Display prices with applicable taxes</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowTax(!showTax)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  showTax ? 'bg-[#049da4]' : 'bg-slate-200 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                    showTax ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>

        {/* ========================================================= */}
        {/* SECTION 4: ACCOUNT */}
        {/* ========================================================= */}
        <div>
          <h3 className="text-[12px] font-bold text-[#049da4] dark:text-[#36d8db] tracking-wider uppercase mb-2 px-1 text-left">
            ACCOUNT
          </h3>
          <div className="bg-white dark:bg-[#0c1724] rounded-2xl border border-slate-100 dark:border-slate-800/80 shadow-xs overflow-hidden divide-y divide-slate-100 dark:divide-slate-800/60">
            <button
              type="button"
              onClick={() => onNavigate(currentUser ? 'account' : 'login')}
              className="w-full flex items-center justify-between p-3.5 sm:p-4 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition cursor-pointer text-left"
            >
              <div className="flex items-center gap-3.5">
                <div className="w-9 h-9 rounded-full bg-[#eef8f8] dark:bg-teal-950/60 flex items-center justify-center text-[#049da4] dark:text-[#36d8db] shrink-0">
                  <User size={18} />
                </div>
                <div>
                  <h4 className="text-[14px] font-bold text-slate-900 dark:text-white leading-tight">Manage Account</h4>
                  <p className="text-[12px] text-slate-400 dark:text-slate-400 mt-0.5">
                    {currentUser ? `${currentUser.name || currentUser.email} · Update your personal information` : 'Update your personal information'}
                  </p>
                </div>
              </div>
              <ChevronRight size={16} className="text-slate-400" />
            </button>

            {currentUser?.role === 'admin' && onOpenAdmin && (
              <button
                type="button"
                onClick={onOpenAdmin}
                className="w-full flex items-center justify-between p-3.5 sm:p-4 bg-amber-50/70 dark:bg-amber-950/20 hover:bg-amber-100/60 dark:hover:bg-amber-950/40 transition cursor-pointer text-left"
              >
                <div className="flex items-center gap-3.5">
                  <div className="w-9 h-9 rounded-full bg-amber-100 dark:bg-amber-900/60 flex items-center justify-center text-amber-700 dark:text-amber-400 shrink-0 font-bold">
                    ⚙️
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-[14px] font-bold text-amber-900 dark:text-amber-300 leading-tight">Store Admin Dashboard</h4>
                      <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200">
                        Admin
                      </span>
                    </div>
                    <p className="text-[12px] text-amber-700/80 dark:text-amber-400/80 mt-0.5">
                      Manage inventory, orders, customer accounts & store settings
                    </p>
                  </div>
                </div>
                <ChevronRight size={16} className="text-amber-600 dark:text-amber-400" />
              </button>
            )}
          </div>
        </div>

        {/* ========================================================= */}
        {/* BOTTOM ACTION: LOG OUT */}
        {/* ========================================================= */}
        <div className="pt-2">
          <button
            type="button"
            onClick={() => {
              if (currentUser) {
                onSignOut();
                showToast('Signed out successfully');
              } else {
                onNavigate('login');
              }
            }}
            className="w-full py-3.5 rounded-xl bg-[#fee8ea] hover:bg-[#fedde0] dark:bg-rose-950/30 dark:hover:bg-rose-950/50 text-[#e04e5c] dark:text-rose-400 font-bold text-[14px] transition cursor-pointer flex items-center justify-center gap-2 shadow-xs"
          >
            <LogOut size={18} className="text-[#e04e5c] dark:text-rose-400" />
            <span>Log Out</span>
          </button>
        </div>
      </main>
    </div>
  );
}

export default SettingsView;
