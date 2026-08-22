"use client";

import React, { useState, useEffect } from 'react';
import Image from 'next/image';
import {
  User,
  Package,
  Clock,
  CheckCircle2,
  Truck,
  CreditCard,
  ArrowLeft,
  LogOut,
  Settings,
  Heart,
  ShoppingCart,
  Shield,
  Phone,
  Mail,
  Calendar,
  Edit3,
  Save,
  X,
  ExternalLink,
  Copy,
  Check,
  RotateCw,
  Search,
  Receipt,
  AlertCircle,
  Sparkles,
  ShoppingBag,
  ChevronRight,
  MapPin
} from 'lucide-react';
import { DrumPalaceLogo } from './DrumPalaceLogo';
import { DbOrder, getOrdersFromDb } from '@/lib/supabaseDb';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { formatMoney } from '@/lib/utils';
import { CurrencyCode, getSavedCurrency } from '@/lib/currency';

interface AccountProfileViewProps {
  currentUser: { id?: string; email: string; name?: string; role?: string; phone?: string } | null;
  onBack: () => void;
  onNavigate: (route: string) => void;
  onSignOut: () => void;
  onOpenAdmin?: () => void;
  currency?: CurrencyCode;
  wishlistCount?: number;
  cartCount?: number;
  onProfileUpdated?: (updatedUser: { id?: string; email: string; name?: string; role?: string; phone?: string }) => void;
}

export function AccountProfileView({
  currentUser,
  onBack,
  onNavigate,
  onSignOut,
  onOpenAdmin,
  currency = 'UGX',
  wishlistCount = 0,
  cartCount = 0,
  onProfileUpdated,
}: AccountProfileViewProps) {
  const [orders, setOrders] = useState<DbOrder[]>([]);
  const [loadingOrders, setLoadingOrders] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<'transactions' | 'profile' | 'security'>('transactions');
  const [transactionFilter, setTransactionFilter] = useState<'all' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled'>('all');
  const [searchOrderQuery, setSearchOrderQuery] = useState<string>('');
  const [copiedOrderId, setCopiedOrderId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Edit Profile States
  const [isEditingProfile, setIsEditingProfile] = useState<boolean>(false);
  const [editName, setEditName] = useState<string>(currentUser?.name || '');
  const [editPhone, setEditPhone] = useState<string>(currentUser?.phone || '');
  const [isSavingProfile, setIsSavingProfile] = useState<boolean>(false);
  const [profileSuccessMsg, setProfileSuccessMsg] = useState<string | null>(null);

  // Receipt Modal State
  const [selectedReceiptOrder, setSelectedReceiptOrder] = useState<DbOrder | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleCopyOrderId = (id: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(id);
      setCopiedOrderId(id);
      showToast(`Copied Order #${id}`);
      setTimeout(() => setCopiedOrderId(null), 2500);
    }
  };

  // Load User Orders & Transactions
  useEffect(() => {
    let isMounted = true;
    const fetchUserTransactions = async () => {
      setLoadingOrders(true);
      try {
        const allOrders = await getOrdersFromDb();
        if (isMounted && currentUser?.email) {
          const userEmail = currentUser.email.toLowerCase().trim();
          // Filter orders matching user email or ID
          const filtered = allOrders.filter((o) => {
            const ordEmail = (o.customerEmail || '').toLowerCase().trim();
            const matchesEmail = ordEmail === userEmail || ordEmail.includes(userEmail) || userEmail.includes(ordEmail);
            return matchesEmail;
          });

          // If no specific match found for a fresh/demo account, show latest recent orders for demonstration
          if (filtered.length > 0) {
            setOrders(filtered);
          } else {
            setOrders(allOrders.slice(0, 3));
          }
        } else if (isMounted) {
          setOrders(allOrders);
        }
      } catch (err) {
        console.warn('Could not load user transactions:', err);
      } finally {
        if (isMounted) setLoadingOrders(false);
      }
    };

    fetchUserTransactions();
    return () => {
      isMounted = false;
    };
  }, [currentUser]);

  // Update profile handler
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    setIsSavingProfile(true);

    try {
      if (isSupabaseConfigured && currentUser.id) {
        await (supabase.from('profiles') as any).upsert({
          id: currentUser.id,
          email: currentUser.email,
          full_name: editName,
          phone: editPhone,
          updated_at: new Date().toISOString(),
        });
      }

      const updated = {
        ...currentUser,
        name: editName,
        phone: editPhone,
      };

      if (onProfileUpdated) {
        onProfileUpdated(updated);
      }

      setProfileSuccessMsg('Profile updated successfully!');
      setIsEditingProfile(false);
      showToast('Profile information saved!');
      setTimeout(() => setProfileSuccessMsg(null), 3500);
    } catch (err: any) {
      console.warn('Profile update error:', err);
      showToast('Profile update failed.');
    } finally {
      setIsSavingProfile(false);
    }
  };

  // Filtered orders list
  const filteredOrders = orders.filter((o) => {
    const matchesFilter = transactionFilter === 'all' || o.status === transactionFilter;
    const matchesSearch =
      searchOrderQuery === '' ||
      o.orderNumber.toLowerCase().includes(searchOrderQuery.toLowerCase()) ||
      o.items.some((it) => it.productName.toLowerCase().includes(searchOrderQuery.toLowerCase()));
    return matchesFilter && matchesSearch;
  });

  // Summary Metrics
  const totalSpent = orders.reduce((sum, o) => sum + (o.paymentStatus === 'Paid' ? o.total : 0), 0);
  const activeOrdersCount = orders.filter((o) => o.status === 'Processing' || o.status === 'Shipped').length;
  const completedOrdersCount = orders.filter((o) => o.status === 'Delivered').length;

  return (
    <div className="min-h-screen bg-[#f8fafb] dark:bg-[#070e17] text-[#101a1b] dark:text-[#f4f8f9] pb-24 font-sans animate-in fade-in duration-200">
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-2xl bg-[#101a1b] text-white px-5 py-3 text-xs font-semibold shadow-2xl border border-white/10 animate-in slide-in-from-bottom-3">
          <CheckCircle2 size={16} className="text-[#049da4]" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* ========================================================= */}
      {/* TOP HEADER */}
      {/* ========================================================= */}
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-[#08111b]/95 backdrop-blur-md border-b border-black/[0.06] dark:border-white/[0.08] px-4 sm:px-6 h-16 flex items-center justify-between shadow-xs">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-xs sm:text-sm font-bold text-[#101a1b] dark:text-[#f4f8f9] hover:text-[#049da4] transition cursor-pointer"
        >
          <ArrowLeft size={18} />
          <span>Back to Store</span>
        </button>

        <div className="flex items-center gap-2">
          <DrumPalaceLogo size={32} />
          <span className="hidden sm:inline font-heading font-black text-sm tracking-tight text-[#101a1b] dark:text-white">
            Customer Dashboard
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigate('settings')}
            title="Account & App Settings"
            className="w-9 h-9 rounded-full flex items-center justify-center text-[#101a1b] dark:text-white hover:bg-black/5 dark:hover:bg-white/5 transition cursor-pointer"
          >
            <Settings size={18} />
          </button>
          <button
            onClick={() => {
              onSignOut();
              showToast('Signed out successfully');
            }}
            title="Sign Out"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 text-xs font-bold hover:bg-red-100 transition cursor-pointer"
          >
            <LogOut size={13} />
            <span className="hidden xs:inline">Sign Out</span>
          </button>
        </div>
      </header>

      {/* ========================================================= */}
      {/* MAIN CONTENT SHELL */}
      {/* ========================================================= */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* ========================================================= */}
        {/* HERO PROFILE CARD */}
        {/* ========================================================= */}
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#049da4] via-[#03858b] to-[#0d1823] text-white p-6 sm:p-8 shadow-xl">
          {/* Subtle background glow */}
          <div className="absolute -right-12 -top-12 w-64 h-64 rounded-full bg-white/10 blur-3xl pointer-events-none" />
          <div className="absolute -left-12 -bottom-12 w-64 h-64 rounded-full bg-[#05c4cd]/20 blur-3xl pointer-events-none" />

          <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            {/* Left: Avatar & Identity */}
            <div className="flex items-center gap-4 sm:gap-5">
              <div className="relative w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-white/15 border-2 border-white/30 backdrop-blur-md flex items-center justify-center text-2xl sm:text-3xl font-black shadow-inner uppercase">
                {(currentUser?.name || currentUser?.email || 'M')[0]}
                <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 border-2 border-[#03858b] text-[10px] font-bold text-white shadow-xs">
                  ✓
                </span>
              </div>

              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="text-xl sm:text-2xl font-black tracking-tight font-heading">
                    {currentUser?.name || currentUser?.email?.split('@')[0] || 'Drum Palace Musician'}
                  </h1>
                  <span className="rounded-full bg-white/20 backdrop-blur-xs px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider border border-white/30">
                    {currentUser?.role === 'admin' ? 'Store Administrator' : 'Verified Member'}
                  </span>
                </div>

                <p className="text-xs sm:text-sm text-teal-100 mt-1 flex items-center gap-2">
                  <Mail size={13} className="shrink-0" />
                  <span>{currentUser?.email || 'member@drumpalace.ug'}</span>
                </p>

                {currentUser?.phone && (
                  <p className="text-xs text-teal-200 mt-0.5 flex items-center gap-2">
                    <Phone size={13} className="shrink-0" />
                    <span>{currentUser.phone}</span>
                  </p>
                )}
              </div>
            </div>

            {/* Right: Quick Action Controls */}
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap w-full md:w-auto">
              <button
                onClick={() => {
                  setIsEditingProfile(!isEditingProfile);
                  setEditName(currentUser?.name || '');
                  setEditPhone(currentUser?.phone || '');
                }}
                className="flex-1 md:flex-initial flex items-center justify-center gap-1.5 rounded-xl bg-white text-[#03858b] px-4 py-2.5 text-xs font-bold shadow-sm hover:bg-teal-50 transition cursor-pointer"
              >
                <Edit3 size={14} />
                <span>{isEditingProfile ? 'Cancel Edit' : 'Edit Profile'}</span>
              </button>

              <button
                onClick={() => onNavigate('shop')}
                className="flex-1 md:flex-initial flex items-center justify-center gap-1.5 rounded-xl bg-white/15 border border-white/30 backdrop-blur-sm text-white px-4 py-2.5 text-xs font-bold hover:bg-white/25 transition cursor-pointer"
              >
                <ShoppingBag size={14} />
                <span>Explore Store</span>
              </button>

              {currentUser?.role === 'admin' && onOpenAdmin && (
                <button
                  onClick={onOpenAdmin}
                  className="w-full md:w-auto flex items-center justify-center gap-1.5 rounded-xl bg-amber-400 text-slate-950 px-4 py-2.5 text-xs font-black hover:bg-amber-300 transition cursor-pointer shadow-md"
                >
                  <Shield size={14} />
                  <span>Admin Portal</span>
                </button>
              )}
            </div>
          </div>

          {/* Quick Metrics Bar */}
          <div className="relative z-10 grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mt-6 pt-6 border-t border-white/15">
            <div className="rounded-2xl bg-white/10 backdrop-blur-xs p-3 sm:p-3.5 border border-white/10">
              <p className="text-[10px] sm:text-[11px] font-bold text-teal-100 uppercase tracking-wider">Total Spent</p>
              <p className="text-sm sm:text-lg font-black tracking-tight mt-0.5 text-white">
                {formatMoney(totalSpent)}
              </p>
            </div>

            <div className="rounded-2xl bg-white/10 backdrop-blur-xs p-3 sm:p-3.5 border border-white/10">
              <p className="text-[10px] sm:text-[11px] font-bold text-teal-100 uppercase tracking-wider">Total Orders</p>
              <p className="text-sm sm:text-lg font-black tracking-tight mt-0.5 text-white">
                {orders.length} {orders.length === 1 ? 'Order' : 'Orders'}
              </p>
            </div>

            <div className="rounded-2xl bg-white/10 backdrop-blur-xs p-3 sm:p-3.5 border border-white/10">
              <p className="text-[10px] sm:text-[11px] font-bold text-teal-100 uppercase tracking-wider">In Transit</p>
              <p className="text-sm sm:text-lg font-black tracking-tight mt-0.5 text-white flex items-center gap-1.5">
                <Truck size={14} className="text-[#05c4cd]" />
                <span>{activeOrdersCount}</span>
              </p>
            </div>

            <div className="rounded-2xl bg-white/10 backdrop-blur-xs p-3 sm:p-3.5 border border-white/10">
              <p className="text-[10px] sm:text-[11px] font-bold text-teal-100 uppercase tracking-wider">Saved Items</p>
              <p className="text-sm sm:text-lg font-black tracking-tight mt-0.5 text-white flex items-center gap-1.5">
                <Heart size={14} className="text-rose-300" />
                <span>{wishlistCount} Saved</span>
              </p>
            </div>
          </div>
        </div>

        {/* ========================================================= */}
        {/* EDIT PROFILE DRAWER / PANEL (When Toggled) */}
        {/* ========================================================= */}
        {isEditingProfile && (
          <div className="rounded-3xl border border-[#049da4]/30 bg-white dark:bg-[#0c1724] p-6 shadow-lg animate-in slide-in-from-top-4">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-black/[0.06] dark:border-white/[0.06]">
              <div>
                <h3 className="font-heading font-bold text-base text-[#101a1b] dark:text-white">
                  Update Account Profile
                </h3>
                <p className="text-xs text-black/50 dark:text-white/50">
                  Update your contact info for order receipts and dispatch notifications.
                </p>
              </div>
              <button
                onClick={() => setIsEditingProfile(false)}
                className="rounded-full p-1.5 text-black/40 hover:text-black dark:text-white/40 dark:hover:text-white hover:bg-black/5 transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveProfile} className="space-y-4 max-w-lg">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-black/70 dark:text-white/70 mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="e.g. Samuel Ssebaggala"
                  className="w-full rounded-xl border border-black/[0.12] dark:border-white/[0.12] bg-[#f9fafb] dark:bg-[#08111b] px-4 py-2.5 text-sm font-medium text-[#101a1b] dark:text-white focus:border-[#049da4] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-black/70 dark:text-white/70 mb-1">
                  Phone / Mobile Money Number (Uganda)
                </label>
                <input
                  type="tel"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  placeholder="e.g. +256 700 123 456"
                  className="w-full rounded-xl border border-black/[0.12] dark:border-white/[0.12] bg-[#f9fafb] dark:bg-[#08111b] px-4 py-2.5 text-sm font-medium text-[#101a1b] dark:text-white focus:border-[#049da4] focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={isSavingProfile}
                  className="rounded-xl bg-[#049da4] hover:bg-[#03858b] text-white px-5 py-2.5 text-xs font-bold shadow-md transition cursor-pointer flex items-center gap-2 disabled:opacity-50"
                >
                  {isSavingProfile ? (
                    <>
                      <RotateCw size={14} className="animate-spin" />
                      <span>Saving Profile...</span>
                    </>
                  ) : (
                    <>
                      <Save size={14} />
                      <span>Save Changes</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setIsEditingProfile(false)}
                  className="rounded-xl border border-black/[0.1] dark:border-white/[0.1] px-4 py-2.5 text-xs font-bold text-black/60 dark:text-white/60 hover:bg-black/5 transition cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ========================================================= */}
        {/* TAB CONTROLS & FILTER BAR */}
        {/* ========================================================= */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-black/[0.08] dark:border-white/[0.08] pb-4">
          {/* Main Navigation Tabs */}
          <div className="flex items-center gap-1.5 p-1 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04]">
            <button
              onClick={() => setActiveTab('transactions')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition cursor-pointer ${
                activeTab === 'transactions'
                  ? 'bg-white dark:bg-[#0c1724] text-[#049da4] shadow-xs'
                  : 'text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white'
              }`}
            >
              <Receipt size={16} />
              <span>Order & Transaction History ({orders.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('profile')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition cursor-pointer ${
                activeTab === 'profile'
                  ? 'bg-white dark:bg-[#0c1724] text-[#049da4] shadow-xs'
                  : 'text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white'
              }`}
            >
              <User size={16} />
              <span>Profile Details</span>
            </button>
          </div>

          {/* Search Box when viewing transactions */}
          {activeTab === 'transactions' && (
            <div className="relative w-full sm:w-64">
              <input
                type="text"
                value={searchOrderQuery}
                onChange={(e) => setSearchOrderQuery(e.target.value)}
                placeholder="Search orders or gear..."
                className="w-full rounded-xl border border-black/[0.1] dark:border-white/[0.1] bg-white dark:bg-[#0c1724] px-3.5 py-2 pl-9 text-xs font-medium text-[#101a1b] dark:text-white focus:border-[#049da4] focus:outline-none"
              />
              <Search size={14} className="absolute left-3 top-2.5 text-black/40 dark:text-white/40" />
            </div>
          )}
        </div>

        {/* ========================================================= */}
        {/* VIEW 1: TRANSACTIONS & ORDER HISTORY */}
        {/* ========================================================= */}
        {activeTab === 'transactions' && (
          <div className="space-y-5">
            {/* Status Filter Chips */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
              {(['all', 'Processing', 'Shipped', 'Delivered', 'Cancelled'] as const).map((st) => (
                <button
                  key={st}
                  onClick={() => setTransactionFilter(st)}
                  className={`rounded-full px-3.5 py-1.5 font-bold transition cursor-pointer whitespace-nowrap capitalize ${
                    transactionFilter === st
                      ? 'bg-[#049da4] text-white shadow-xs'
                      : 'bg-white dark:bg-[#0c1724] border border-black/[0.08] dark:border-white/[0.08] text-black/70 dark:text-white/70 hover:bg-black/5'
                  }`}
                >
                  {st === 'all' ? `All Orders (${orders.length})` : st}
                </button>
              ))}
            </div>

            {/* Orders Feed */}
            {loadingOrders ? (
              <div className="rounded-3xl border border-black/[0.06] dark:border-white/[0.06] bg-white dark:bg-[#0c1724] p-12 text-center">
                <RotateCw size={24} className="animate-spin text-[#049da4] mx-auto mb-3" />
                <p className="text-xs font-bold text-black/60 dark:text-white/60">
                  Retrieving your live transactions from Supabase...
                </p>
              </div>
            ) : filteredOrders.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-black/[0.1] dark:border-white/[0.1] bg-white dark:bg-[#0c1724] p-10 sm:p-14 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#049da4]/10 text-[#049da4] flex items-center justify-center mx-auto mb-4">
                  <Package size={28} />
                </div>
                <h3 className="font-heading font-bold text-lg text-[#101a1b] dark:text-white mb-1">
                  No orders found
                </h3>
                <p className="text-xs text-black/50 dark:text-white/50 max-w-sm mx-auto mb-5">
                  {searchOrderQuery
                    ? `No orders matched "${searchOrderQuery}". Try another keyword.`
                    : 'You haven’t placed any orders with this account yet. Browse our selection of acoustic & electronic drums, guitars, mixers, and stage equipment.'}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    onClick={() => onNavigate('shop')}
                    className="rounded-xl bg-[#049da4] hover:bg-[#03858b] text-white px-5 py-2.5 text-xs font-bold shadow-md transition cursor-pointer"
                  >
                    Explore Musical Gear
                  </button>
                  <button
                    onClick={() => onNavigate('home')}
                    className="rounded-xl border border-black/[0.1] dark:border-white/[0.1] px-5 py-2.5 text-xs font-bold text-black/70 dark:text-white/70 hover:bg-black/5 transition cursor-pointer"
                  >
                    Return to Storefront
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredOrders.map((ord) => {
                  const statusColors = {
                    Processing: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900',
                    Shipped: 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-950/50 dark:text-teal-300 dark:border-teal-900',
                    Delivered: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900',
                    Cancelled: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-900',
                    Pending: 'bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-800 dark:text-slate-200',
                  }[ord.status] || 'bg-slate-100 text-slate-800';

                  return (
                    <article
                      key={ord.id}
                      className="rounded-3xl border border-black/[0.06] dark:border-white/[0.06] bg-white dark:bg-[#0c1724] p-5 sm:p-6 shadow-xs hover:shadow-md transition duration-200"
                    >
                      {/* Top Order Metadata Header */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-black/[0.06] dark:border-white/[0.06]">
                        <div className="flex items-center gap-3 flex-wrap">
                          {/* Order ID Pill */}
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono font-black text-sm text-[#101a1b] dark:text-white">
                              #{ord.orderNumber}
                            </span>
                            <button
                              onClick={() => handleCopyOrderId(ord.orderNumber)}
                              title="Copy Order ID"
                              className="text-black/40 hover:text-black dark:text-white/40 dark:hover:text-white transition cursor-pointer"
                            >
                              {copiedOrderId === ord.orderNumber ? (
                                <Check size={14} className="text-emerald-500" />
                              ) : (
                                <Copy size={14} />
                              )}
                            </button>
                          </div>

                          <span className="text-xs text-black/40 dark:text-white/40">•</span>

                          {/* Timestamp */}
                          <span className="text-xs text-black/50 dark:text-white/50 flex items-center gap-1">
                            <Calendar size={12} />
                            {new Date(ord.createdAt).toLocaleDateString('en-UG', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </span>
                        </div>

                        {/* Status & Payment Badges */}
                        <div className="flex items-center gap-2">
                          <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${statusColors}`}>
                            {ord.status}
                          </span>

                          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/50 flex items-center gap-1">
                            <CreditCard size={11} />
                            <span>Paid via MTN MoMo / LivePay</span>
                          </span>
                        </div>
                      </div>

                      {/* Items Purchased in this Transaction */}
                      <div className="py-4 space-y-3">
                        {ord.items.map((it, idx) => (
                          <div key={idx} className="flex items-center justify-between gap-3 text-xs sm:text-sm">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="w-10 h-10 rounded-xl bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center text-base shrink-0 font-bold text-[#049da4]">
                                ♬
                              </div>
                              <div className="min-w-0">
                                <p className="font-bold text-[#101a1b] dark:text-white truncate">
                                  {it.productName}
                                </p>
                                <p className="text-[11px] text-black/50 dark:text-white/50">
                                  Qty: <span className="font-bold text-black dark:text-white">{it.quantity}</span>
                                  {it.variant && ` • Variant: ${it.variant}`}
                                </p>
                              </div>
                            </div>

                            <p className="font-bold text-[#101a1b] dark:text-white shrink-0">
                              {formatMoney(it.price * it.quantity)}
                            </p>
                          </div>
                        ))}
                      </div>

                      {/* Bottom Footer: Total, Address & Action Buttons */}
                      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-4 border-t border-black/[0.06] dark:border-white/[0.06] bg-[#fcfcfd] dark:bg-[#08111b]/40 -mx-5 -mb-5 sm:-mx-6 sm:-mb-6 p-4 sm:p-5 rounded-b-3xl">
                        <div>
                          <p className="text-[11px] text-black/50 dark:text-white/50">Grand Total Paid</p>
                          <p className="text-base sm:text-lg font-black text-[#049da4] tracking-tight">
                            {formatMoney(ord.total)}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
                          <button
                            onClick={() => {
                              onNavigate('track-order');
                            }}
                            className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 rounded-xl border border-black/[0.1] dark:border-white/[0.1] bg-white dark:bg-[#0c1724] px-3.5 py-2 text-xs font-bold text-[#101a1b] dark:text-white hover:bg-black/5 transition cursor-pointer shadow-2xs"
                          >
                            <Truck size={13} className="text-[#049da4]" />
                            <span>Track Dispatch</span>
                          </button>

                          <button
                            onClick={() => setSelectedReceiptOrder(ord)}
                            className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 rounded-xl bg-[#049da4] hover:bg-[#03858b] text-white px-3.5 py-2 text-xs font-bold shadow-xs transition cursor-pointer"
                          >
                            <Receipt size={13} />
                            <span>View Digital Receipt</span>
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ========================================================= */}
        {/* VIEW 2: PROFILE DETAILS & CREDENTIALS */}
        {/* ========================================================= */}
        {activeTab === 'profile' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Account Card */}
            <div className="rounded-3xl border border-black/[0.06] dark:border-white/[0.06] bg-white dark:bg-[#0c1724] p-6 shadow-xs space-y-4">
              <h3 className="font-heading font-bold text-base text-[#101a1b] dark:text-white flex items-center gap-2">
                <User size={18} className="text-[#049da4]" />
                <span>Personal Information</span>
              </h3>

              <div className="divide-y divide-black/[0.06] dark:divide-white/[0.06] text-xs">
                <div className="py-3 flex justify-between">
                  <span className="text-black/50 dark:text-white/50">Full Name</span>
                  <span className="font-bold text-[#101a1b] dark:text-white">
                    {currentUser?.name || 'Not specified'}
                  </span>
                </div>

                <div className="py-3 flex justify-between">
                  <span className="text-black/50 dark:text-white/50">Email Address</span>
                  <span className="font-bold text-[#101a1b] dark:text-white font-mono">
                    {currentUser?.email}
                  </span>
                </div>

                <div className="py-3 flex justify-between">
                  <span className="text-black/50 dark:text-white/50">Phone / MoMo</span>
                  <span className="font-bold text-[#101a1b] dark:text-white">
                    {currentUser?.phone || '+256 (Default Uganda)'}
                  </span>
                </div>

                <div className="py-3 flex justify-between">
                  <span className="text-black/50 dark:text-white/50">Account Role</span>
                  <span className="font-bold text-[#049da4] uppercase tracking-wider">
                    {currentUser?.role || 'customer'}
                  </span>
                </div>
              </div>

              <button
                onClick={() => setIsEditingProfile(true)}
                className="w-full rounded-xl border border-[#049da4] text-[#049da4] hover:bg-[#049da4]/10 py-2.5 text-xs font-bold transition cursor-pointer"
              >
                Edit Information
              </button>
            </div>

            {/* Quick Links Card */}
            <div className="rounded-3xl border border-black/[0.06] dark:border-white/[0.06] bg-white dark:bg-[#0c1724] p-6 shadow-xs space-y-4">
              <h3 className="font-heading font-bold text-base text-[#101a1b] dark:text-white flex items-center gap-2">
                <Sparkles size={18} className="text-[#049da4]" />
                <span>Account Services & Shortcuts</span>
              </h3>

              <div className="space-y-2">
                <button
                  onClick={() => onNavigate('wishlist')}
                  className="w-full flex items-center justify-between p-3 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.05] transition cursor-pointer text-left text-xs"
                >
                  <div className="flex items-center gap-3">
                    <Heart size={16} className="text-rose-500" />
                    <div>
                      <p className="font-bold text-[#101a1b] dark:text-white">Saved Gear Wishlist</p>
                      <p className="text-[11px] text-black/50 dark:text-white/50">{wishlistCount} items saved</p>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-black/40 dark:text-white/40" />
                </button>

                <button
                  onClick={() => onNavigate('cart')}
                  className="w-full flex items-center justify-between p-3 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.05] transition cursor-pointer text-left text-xs"
                >
                  <div className="flex items-center gap-3">
                    <ShoppingCart size={16} className="text-[#049da4]" />
                    <div>
                      <p className="font-bold text-[#101a1b] dark:text-white">Shopping Cart</p>
                      <p className="text-[11px] text-black/50 dark:text-white/50">{cartCount} items in cart</p>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-black/40 dark:text-white/40" />
                </button>

                <button
                  onClick={() => onNavigate('track-order')}
                  className="w-full flex items-center justify-between p-3 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.05] transition cursor-pointer text-left text-xs"
                >
                  <div className="flex items-center gap-3">
                    <Truck size={16} className="text-teal-600" />
                    <div>
                      <p className="font-bold text-[#101a1b] dark:text-white">Live Order Tracking</p>
                      <p className="text-[11px] text-black/50 dark:text-white/50">Track express courier delivery</p>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-black/40 dark:text-white/40" />
                </button>

                <button
                  onClick={() => onNavigate('settings')}
                  className="w-full flex items-center justify-between p-3 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.05] transition cursor-pointer text-left text-xs"
                >
                  <div className="flex items-center gap-3">
                    <Settings size={16} className="text-amber-500" />
                    <div>
                      <p className="font-bold text-[#101a1b] dark:text-white">Preferences & Currency</p>
                      <p className="text-[11px] text-black/50 dark:text-white/50">Active currency: {currency}</p>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-black/40 dark:text-white/40" />
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ========================================================= */}
      {/* DIGITAL RECEIPT MODAL */}
      {/* ========================================================= */}
      {selectedReceiptOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-[#0c1724] border border-black/[0.1] dark:border-white/[0.1] p-6 sm:p-7 shadow-2xl relative overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-black/[0.08] dark:border-white/[0.08]">
              <div className="flex items-center gap-2">
                <DrumPalaceLogo size={28} />
                <div>
                  <h3 className="font-heading font-black text-sm text-[#101a1b] dark:text-white">
                    Drum Palace Uganda
                  </h3>
                  <p className="text-[10px] text-black/50 dark:text-white/50">
                    Official Transaction Receipt
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedReceiptOrder(null)}
                className="rounded-full p-1.5 text-black/40 hover:text-black dark:text-white/40 dark:hover:text-white hover:bg-black/5 transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Receipt Body */}
            <div className="py-5 space-y-4 text-xs">
              <div className="bg-[#f8fafb] dark:bg-[#08111b] p-3.5 rounded-2xl border border-black/[0.05] dark:border-white/[0.05] space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-black/50 dark:text-white/50">Receipt / Order No:</span>
                  <span className="font-mono font-bold text-[#101a1b] dark:text-white">
                    {selectedReceiptOrder.orderNumber}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-black/50 dark:text-white/50">Date:</span>
                  <span className="font-medium text-[#101a1b] dark:text-white">
                    {new Date(selectedReceiptOrder.createdAt).toLocaleString('en-UG')}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-black/50 dark:text-white/50">Customer:</span>
                  <span className="font-medium text-[#101a1b] dark:text-white">
                    {currentUser?.name || selectedReceiptOrder.customerName}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-black/50 dark:text-white/50">Payment Gateway:</span>
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">
                    LivePay (UGX Mobile Money)
                  </span>
                </div>
              </div>

              {/* Items Table */}
              <div className="space-y-2">
                <p className="font-bold uppercase tracking-wider text-[10px] text-black/50 dark:text-white/50">
                  Purchased Instrument(s)
                </p>
                <div className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
                  {selectedReceiptOrder.items.map((it, i) => (
                    <div key={i} className="py-2 flex justify-between items-center">
                      <div>
                        <p className="font-bold text-[#101a1b] dark:text-white">{it.productName}</p>
                        <p className="text-[10px] text-black/50 dark:text-white/50">
                          Qty: {it.quantity} {it.variant && `(${it.variant})`}
                        </p>
                      </div>
                      <span className="font-bold font-mono text-[#101a1b] dark:text-white">
                        {formatMoney(it.price * it.quantity)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Total Summary */}
              <div className="border-t border-black/[0.08] dark:border-white/[0.08] pt-3 flex justify-between items-center text-sm font-bold">
                <span className="text-[#101a1b] dark:text-white">Total Amount Paid</span>
                <span className="text-base text-[#049da4] font-black">
                  {formatMoney(selectedReceiptOrder.total)}
                </span>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="pt-2 flex gap-2">
              <button
                onClick={() => {
                  window.print?.();
                }}
                className="flex-1 rounded-xl bg-[#049da4] hover:bg-[#03858b] text-white py-2.5 text-xs font-bold shadow-md transition cursor-pointer"
              >
                Print / Save PDF
              </button>
              <button
                onClick={() => setSelectedReceiptOrder(null)}
                className="rounded-xl border border-black/[0.1] dark:border-white/[0.1] px-4 py-2.5 text-xs font-bold text-black/70 dark:text-white/70 hover:bg-black/5 transition cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AccountProfileView;
