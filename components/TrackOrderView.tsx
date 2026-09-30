"use client";

import React, { useState } from 'react';
import {
  ArrowLeft,
  Search,
  Truck,
  CheckCircle2,
  Clock,
  Package,
  MapPin,
  Phone,
  ShieldCheck,
  AlertCircle,
  ChevronRight
} from 'lucide-react';
import { formatPrice, getSavedCurrency } from '@/lib/currency';

interface TrackedOrder {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  total: number;
  currency: string;
  createdAt: string;
  itemCount: number;
  items: { productName: string; quantity: number; variant?: string }[];
}

interface TrackOrderViewProps {
  onBack: () => void;
  onNavigate: (route: string) => void;
}

export function TrackOrderView({ onBack, onNavigate }: TrackOrderViewProps) {
  const [orderQuery, setOrderQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchedOrder, setSearchedOrder] = useState<TrackedOrder | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const currency = getSavedCurrency();

  // NOTE: we deliberately do NOT auto-load "the latest order" here anymore —
  // that exposed another customer's PII to whoever opened this page.

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderQuery.trim()) return;
    setIsSearching(true);
    setNotFound(false);

    try {
      // Public tracking endpoint returns a PII-redacted view of the order.
      const res = await fetch(`/api/orders?track=${encodeURIComponent(orderQuery.trim())}`);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && data.order) {
        setSearchedOrder(data.order);
        setNotFound(false);
      } else {
        setSearchedOrder(null);
        setNotFound(true);
      }
      setHasSearched(true);
    } catch (err) {
      console.error('Error tracking order:', err);
      setNotFound(true);
    } finally {
      setIsSearching(false);
    }
  };

  const getStepStatus = (status: string) => {
    const s = (status || 'Processing').toLowerCase();
    if (s === 'delivered') return 4;
    if (s === 'shipped') return 3;
    if (s === 'processing') return 2;
    if (s === 'pending') return 1;
    return 2;
  };

  const currentStep = searchedOrder ? getStepStatus(searchedOrder.status) : 2;

  return (
    <div className="min-h-screen bg-[#f8fafb] dark:bg-slate-950 text-slate-900 dark:text-slate-100 pb-20 animate-in fade-in duration-200">
      {/* Top Header */}
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 px-4 h-16 flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-slate-800 dark:text-slate-200 font-bold text-sm hover:text-teal-600 dark:hover:text-teal-400 transition cursor-pointer"
        >
          <ArrowLeft size={18} />
          <span>Track Order</span>
        </button>

        <span className="text-xs font-semibold text-teal-600 dark:text-teal-400 flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
          Live Dispatch Center
        </span>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Search Order Number Card */}
        <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white mb-1">
            Enter Your Tracking / Order Number
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
            Found on your order confirmation SMS or receipt (e.g. DP-94821).
          </p>

          <form onSubmit={handleSearch} className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                value={orderQuery}
                onChange={(e) => setOrderQuery(e.target.value)}
                placeholder="e.g. DP-94821 or Order ID"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 pl-10 text-sm font-medium text-slate-900 focus:bg-white focus:border-teal-500 focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white"
              />
              <Search size={16} className="absolute left-3.5 top-3.5 text-slate-400" />
            </div>

            <button
              type="submit"
              disabled={isSearching}
              className="px-5 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold transition cursor-pointer disabled:opacity-60 shrink-0 shadow-xs"
            >
              {isSearching ? 'Querying DB...' : 'Track'}
            </button>
          </form>
        </div>

        {notFound && (
          <div className="bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/60 p-5 rounded-2xl text-center space-y-2">
            <AlertCircle size={28} className="mx-auto text-rose-500" />
            <h4 className="text-sm font-bold text-rose-900 dark:text-rose-200">Order Not Found in Database</h4>
            <p className="text-xs text-rose-600 dark:text-rose-400 max-w-md mx-auto">
              No matching order record for &ldquo;{orderQuery}&rdquo; was found in the database. Please double check your order number or contact support.
            </p>
          </div>
        )}

        {hasSearched && searchedOrder && (
          <div className="space-y-6">
            {/* Status Summary Banner */}
            <div className="bg-gradient-to-br from-teal-600 to-teal-800 text-white p-6 rounded-2xl shadow-md relative overflow-hidden">
              <div className="relative z-10">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/15 text-[11px] font-bold tracking-wide uppercase mb-3">
                  <Truck size={13} />
                  <span>Status: {searchedOrder.status}</span>
                </div>
                <h2 className="text-xl font-extrabold tracking-tight">Order #{searchedOrder.orderNumber}</h2>
                <p className="text-xs text-teal-100 mt-1">
                  Customer details are kept private for your security.
                </p>

                <div className="mt-4 pt-4 border-t border-white/20 grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-teal-200 block text-[10px] uppercase font-bold">Payment</span>
                    <span className="font-semibold text-white">{searchedOrder.paymentStatus} · {formatPrice(searchedOrder.total, currency)}</span>
                  </div>
                  <div>
                    <span className="text-teal-200 block text-[10px] uppercase font-bold">Placed</span>
                    <span className="font-semibold text-white truncate block">{new Date(searchedOrder.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Step-by-Step Progress Timeline */}
            <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs">
              <h4 className="text-xs font-bold text-teal-600 dark:text-teal-400 uppercase tracking-wider mb-5">
                Live Database Tracking Timeline
              </h4>

              <div className="space-y-6 relative before:absolute before:left-3.5 before:top-2 before:bottom-2 before:w-0.5 before:bg-teal-500/30">
                {/* Step 1 */}
                <div className="flex gap-4 items-start relative">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 ring-4 ring-white dark:ring-slate-900 ${currentStep >= 1 ? 'bg-teal-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-400'}`}>
                    <CheckCircle2 size={16} />
                  </div>
                  <div>
                    <h5 className="text-xs font-bold text-slate-900 dark:text-white">Order Placed & Verified</h5>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Order recorded in Supabase database</p>
                    <span className="text-[10px] text-teal-600 dark:text-teal-400 font-semibold">{new Date(searchedOrder.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* Step 2 */}
                <div className="flex gap-4 items-start relative">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 ring-4 ring-white dark:ring-slate-900 ${currentStep >= 2 ? 'bg-teal-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-400'}`}>
                    <CheckCircle2 size={16} />
                  </div>
                  <div>
                    <h5 className="text-xs font-bold text-slate-900 dark:text-white">Workshop Processing & Sound Check</h5>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Inspected by Master Luthier at Namungoona Workshop</p>
                    <span className="text-[10px] text-teal-600 dark:text-teal-400 font-semibold">Quality Verified</span>
                  </div>
                </div>

                {/* Step 3 */}
                <div className="flex gap-4 items-start relative">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 ring-4 ring-white dark:ring-slate-900 ${currentStep >= 3 ? 'bg-teal-600 text-white animate-pulse' : 'bg-slate-200 dark:bg-slate-800 text-slate-400'}`}>
                    <Truck size={14} />
                  </div>
                  <div>
                    <h5 className={`text-xs font-bold ${currentStep >= 3 ? 'text-teal-600 dark:text-teal-400' : 'text-slate-900 dark:text-white'}`}>
                      Dispatched & In Transit
                    </h5>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {currentStep >= 3 ? 'Express courier en route with your instrument' : 'Preparing for carrier dispatch'}
                    </p>
                  </div>
                </div>

                {/* Step 4 */}
                <div className="flex gap-4 items-start relative">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 ring-4 ring-white dark:ring-slate-900 ${currentStep >= 4 ? 'bg-teal-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-400'}`}>
                    <Package size={14} />
                  </div>
                  <div>
                    <h5 className={`text-xs font-bold ${currentStep >= 4 ? 'text-teal-600 dark:text-teal-400' : 'text-slate-900 dark:text-white'}`}>
                      Delivered & Signed
                    </h5>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {currentStep >= 4 ? 'Handed to recipient with 14-day warranty card' : 'Pending final delivery'}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Item Breakdown from Database */}
            <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs">
              <h4 className="text-xs font-bold text-slate-900 dark:text-white mb-3">
                Package Contents ({searchedOrder.items?.length || 0} items)
              </h4>
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {searchedOrder.items && searchedOrder.items.length > 0 ? (
                  searchedOrder.items.map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between py-2.5 text-xs">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-teal-50 dark:bg-teal-950 flex items-center justify-center text-teal-600 font-bold">
                          DP
                        </div>
                        <div>
                          <p className="font-bold text-slate-900 dark:text-white">{item.productName}</p>
                          <span className="text-[10px] text-slate-400">
                            Qty: {item.quantity} {item.variant ? `· Finish: ${item.variant}` : ''}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-slate-400 py-2">Item details loaded from database record.</p>
                )}
              </div>

              <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs font-semibold">
                <span className="text-slate-500">Need help with this order?</span>
                <button
                  onClick={() => onNavigate('contact')}
                  className="text-teal-600 dark:text-teal-400 hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <Phone size={12} /> Contact Dispatch
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default TrackOrderView;
