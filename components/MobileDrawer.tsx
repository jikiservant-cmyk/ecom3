"use client";

import React from 'react';
import {
  X,
  Home,
  ShoppingBag,
  LayoutGrid,
  Star,
  Heart,
  ShoppingCart,
  User,
  Ticket,
  HelpCircle,
  ShieldCheck,
  Settings,
  Info,
  Phone,
  LogOut,
  LogIn,
  ChevronRight,
  Shield
} from 'lucide-react';
import { DrumPalaceLogo } from './DrumPalaceLogo';

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  currentRoute: string;
  onNavigate: (route: string) => void;
  cartCount: number;
  wishlistCount: number;
  currentUser: { id?: string; email: string; name?: string; role?: string } | null;
  onSignOut: () => void;
  onOpenAdmin?: () => void;
}

export function MobileDrawer({
  isOpen,
  onClose,
  currentRoute,
  onNavigate,
  cartCount,
  wishlistCount,
  currentUser,
  onSignOut,
  onOpenAdmin,
}: MobileDrawerProps) {
  if (!isOpen) return null;

  const handleItemClick = (route: string) => {
    onNavigate(route);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex animate-in fade-in duration-200">
      {/* Dark Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs transition-opacity"
      />

      {/* Slide-out Drawer Panel - Pure White by default, slate-900 in dark mode */}
      <div className="relative w-full max-w-[320px] sm:max-w-[360px] bg-white dark:bg-[#08111b] h-full flex flex-col shadow-2xl z-10 overflow-y-auto animate-in slide-in-from-left duration-300">
        {/* Top Close Button (X) */}
        <div className="flex items-center justify-end p-4 pb-0">
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <X size={20} />
          </button>
        </div>

        {/* Brand Header */}
        <div className="px-6 pb-5 pt-0 flex flex-col items-center text-center">
          <DrumPalaceLogo size={160} />
          <p className="text-[12px] font-semibold text-[#049da4] dark:text-[#36d8db] mt-1.5">
            Premium Instruments & Pro Audio Gear
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            For Stage. For Studio. For You.
          </p>
        </div>

        {/* User Status / Quick Sign In Card */}
        <div className="px-4 pb-3">
          {currentUser ? (
            <div className="p-3.5 rounded-2xl bg-teal-50/80 border border-teal-200/70 dark:bg-teal-950/40 dark:border-teal-900/50 flex items-center justify-between">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-full bg-[#049da4] text-white flex items-center justify-center font-bold text-sm shrink-0">
                  {(currentUser.name || currentUser.email || 'U')[0].toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-900 dark:text-white truncate">
                    {currentUser.name || currentUser.email.split('@')[0]}
                  </p>
                  <p className="text-[10px] text-[#049da4] dark:text-[#36d8db] font-semibold truncate">
                    {currentUser.role === 'admin' ? 'Store Administrator' : currentUser.email}
                  </p>
                </div>
              </div>
              <button
                onClick={() => handleItemClick('account')}
                className="px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 border border-teal-200 dark:border-teal-800 text-[11px] font-bold text-teal-800 dark:text-teal-300 hover:bg-teal-100/50 transition cursor-pointer shrink-0"
              >
                Profile & History
              </button>
            </div>
          ) : (
            <button
              onClick={() => handleItemClick('login')}
              className="w-full p-3 rounded-2xl bg-gradient-to-r from-[#049da4] to-[#03858b] text-white flex items-center justify-between shadow-sm hover:brightness-105 transition cursor-pointer"
            >
              <div className="flex items-center gap-2.5 text-left">
                <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center shrink-0">
                  <LogIn size={16} className="text-white" />
                </div>
                <div>
                  <p className="text-xs font-bold leading-tight">Sign In / Register</p>
                  <p className="text-[10px] text-teal-100 font-medium">Access your orders & wishlist</p>
                </div>
              </div>
              <ChevronRight size={16} className="text-white/80" />
            </button>
          )}
        </div>

        {/* Navigation Sections */}
        <div className="flex-1 px-3 py-2 space-y-4">
          {/* Main Navigation List */}
          <div className="space-y-0.5">
            <button
              onClick={() => handleItemClick('home')}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                currentRoute === 'home'
                  ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                  : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
              }`}
            >
              <div className="flex items-center gap-3">
                <Home size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                <span>Home</span>
              </div>
              <ChevronRight size={16} className="text-slate-400" />
            </button>

            <button
              onClick={() => handleItemClick('shop')}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                currentRoute === 'shop'
                  ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                  : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
              }`}
            >
              <div className="flex items-center gap-3">
                <ShoppingBag size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                <span>Shop</span>
              </div>
              <ChevronRight size={16} className="text-slate-400" />
            </button>

            <button
              onClick={() => handleItemClick('categories')}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                currentRoute === 'categories'
                  ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                  : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
              }`}
            >
              <div className="flex items-center gap-3">
                <LayoutGrid size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                <span>Categories</span>
              </div>
              <ChevronRight size={16} className="text-slate-400" />
            </button>

            <button
              onClick={() => handleItemClick('shop')}
              className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60 transition cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <Star size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                <span>Featured Products</span>
              </div>
              <ChevronRight size={16} className="text-slate-400" />
            </button>

            <button
              onClick={() => handleItemClick('wishlist')}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                currentRoute === 'wishlist'
                  ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                  : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
              }`}
            >
              <div className="flex items-center gap-3">
                <Heart size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                <span>Wishlist</span>
              </div>
              <div className="flex items-center gap-2">
                {wishlistCount > 0 && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
                    {wishlistCount}
                  </span>
                )}
                <ChevronRight size={16} className="text-slate-400" />
              </div>
            </button>

            <button
              onClick={() => handleItemClick('cart')}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                currentRoute === 'cart'
                  ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                  : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
              }`}
            >
              <div className="flex items-center gap-3">
                <ShoppingCart size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                <span>Cart</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="flex h-5 min-w-[20px] px-1.5 items-center justify-center rounded-full bg-[#049da4] text-[11px] font-bold text-white">
                  {cartCount > 0 ? cartCount : 2}
                </span>
                <ChevronRight size={16} className="text-slate-400" />
              </div>
            </button>

            <button
              onClick={() => handleItemClick(currentUser ? 'account' : 'track-order')}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                currentRoute === 'account' || currentRoute === 'profile' || currentRoute === 'orders'
                  ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                  : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
              }`}
            >
              <div className="flex items-center gap-3">
                <User size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                <span>{currentUser ? 'My Account & History' : 'Track Orders'}</span>
              </div>
              <ChevronRight size={16} className="text-slate-400" />
            </button>
          </div>

          {/* Support & Info Section */}
          <div className="pt-2">
            <h3 className="px-3.5 text-[12px] font-bold text-[#049da4] dark:text-[#36d8db] mb-1.5 text-left">
              Support & Info
            </h3>
            <div className="space-y-0.5">
              <button
                onClick={() => handleItemClick('track-order')}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                  currentRoute === 'track-order'
                    ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                    : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Ticket size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                  <span>Track Order</span>
                </div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>

              <button
                onClick={() => handleItemClick('faqs')}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                  currentRoute === 'faqs'
                    ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                    : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <HelpCircle size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                  <span>FAQs</span>
                </div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>

              <button
                onClick={() => handleItemClick('shipping')}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                  currentRoute === 'shipping'
                    ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                    : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <ShieldCheck size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                  <span>Shipping & Returns</span>
                </div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>
            </div>
          </div>

          {/* More Section */}
          <div className="pt-2">
            <h3 className="px-3.5 text-[12px] font-bold text-[#049da4] dark:text-[#36d8db] mb-1.5 text-left">
              More
            </h3>
            <div className="space-y-0.5">
              <button
                onClick={() => handleItemClick('settings')}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                  currentRoute === 'settings'
                    ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                    : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Settings size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                  <span>Settings</span>
                </div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>

              <button
                onClick={() => handleItemClick('about')}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                  currentRoute === 'about'
                    ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                    : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Info size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                  <span>About Us</span>
                </div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>

              <button
                onClick={() => handleItemClick('contact')}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition cursor-pointer ${
                  currentRoute === 'contact'
                    ? 'bg-[#eef8f8] text-[#049da4] dark:bg-teal-950/40 dark:text-[#36d8db]'
                    : 'text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Phone size={19} className="text-[#049da4] dark:text-[#36d8db]" />
                  <span>Contact Us</span>
                </div>
                <ChevronRight size={16} className="text-slate-400" />
              </button>

              {currentUser?.role === 'admin' && onOpenAdmin && (
                <button
                  onClick={() => {
                    onOpenAdmin();
                    onClose();
                  }}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[14px] font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 transition cursor-pointer mt-2"
                >
                  <div className="flex items-center gap-3">
                    <Shield size={19} className="text-amber-600" />
                    <span>Store Admin Panel</span>
                  </div>
                  <ChevronRight size={16} className="text-amber-500" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Bottom Action: Log Out or Sign In */}
        <div className="p-4 pt-2 border-t border-slate-100 dark:border-slate-800/80">
          {currentUser ? (
            <button
              onClick={() => {
                onSignOut();
                onClose();
              }}
              className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[14px] font-semibold text-[#e04e5c] hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30 transition cursor-pointer"
            >
              <LogOut size={19} className="text-[#e04e5c]" />
              <span>Log Out</span>
            </button>
          ) : (
            <button
              onClick={() => handleItemClick('login')}
              className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[14px] font-semibold text-[#049da4] dark:text-[#36d8db] hover:bg-teal-50 dark:hover:bg-teal-950/30 transition cursor-pointer"
            >
              <LogIn size={19} className="text-[#049da4] dark:text-[#36d8db]" />
              <span>Sign In / Create Account</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default MobileDrawer;

