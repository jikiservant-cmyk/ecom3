"use client";

import React, { useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Truck,
  RotateCcw,
  CheckCircle2,
  Phone,
  Mail,
  MapPin,
  Sparkles,
  ShoppingBag,
  Package,
  Layers
} from 'lucide-react';
import Image from 'next/image';

// =========================================================
// 1. CATEGORIES VIEW
// =========================================================
interface CategoriesViewProps {
  onBack: () => void;
  onSelectCategory: (cat: string) => void;
  categories?: { id: string; name: string; sub?: string; image: string }[];
  productsCountByCat?: Record<string, number>;
}

const CATEGORY_IMAGES: Record<string, string> = {
  drums: 'https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=800&q=85',
  lighting: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=800&q=85',
  speakers: 'https://images.unsplash.com/photo-1545454675-3531b543be5d?auto=format&fit=crop&w=800&q=85',
  mixers: 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?auto=format&fit=crop&w=800&q=85',
  guitars: 'https://images.unsplash.com/photo-1564186763535-ebb21ef5277f?auto=format&fit=crop&w=800&q=85',
  keyboards: 'https://images.unsplash.com/photo-1520523839898-507127053917?auto=format&fit=crop&w=800&q=85',
  mic: 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=800&q=85',
};

export function CategoriesView({ onBack, onSelectCategory, categories = [], productsCountByCat = {} }: CategoriesViewProps) {
  const displayList = categories.length > 0 ? categories : [
    { id: 'drums', name: 'Drums & Percussion', sub: 'Acoustic & electronic drum sets', image: CATEGORY_IMAGES.drums },
    { id: 'guitars', name: 'Guitars & Basses', sub: 'Electric, acoustic & bass guitars', image: CATEGORY_IMAGES.guitars },
    { id: 'keyboards', name: 'Keyboards & Synths', sub: 'Stage pianos & synthesizers', image: CATEGORY_IMAGES.keyboards },
    { id: 'lighting', name: 'Stage Lighting', sub: 'LED pars & moving heads', image: CATEGORY_IMAGES.lighting },
    { id: 'speakers', name: 'Speakers & PA Systems', sub: 'Powered speakers & subwoofers', image: CATEGORY_IMAGES.speakers },
    { id: 'mixers', name: 'Mixers & Audio Interfaces', sub: 'Studio desks & USB audio', image: CATEGORY_IMAGES.mixers },
  ];

  return (
    <div className="min-h-screen bg-[#f8fafb] dark:bg-slate-950 text-slate-900 dark:text-slate-100 pb-20 animate-in fade-in duration-200">
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 px-4 h-16 flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-slate-800 dark:text-slate-200 font-bold text-sm hover:text-teal-600 dark:hover:text-teal-400 transition cursor-pointer"
        >
          <ArrowLeft size={18} />
          <span>All Categories</span>
        </button>
        <span className="text-xs font-semibold text-teal-600 dark:text-teal-400">
          Pro Instrument Catalog
        </span>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h2 className="text-xl font-extrabold tracking-tight text-slate-900 dark:text-white">
            Explore Sound & Stage Equipment
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Browse premium gear sourced directly from world-class manufacturers with full warranty.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {displayList.map((cat) => {
            const count = productsCountByCat[cat.id] ?? (productsCountByCat[cat.name.toLowerCase()] ?? 0);
            const imageSrc = cat.image || CATEGORY_IMAGES[cat.id] || CATEGORY_IMAGES.drums;

            return (
              <div
                key={cat.id}
                className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 overflow-hidden shadow-xs hover:shadow-md transition flex flex-col group"
              >
                <div className="relative h-44 w-full overflow-hidden bg-slate-100 dark:bg-slate-800">
                  <Image
                    src={imageSrc}
                    alt={cat.name}
                    fill
                    className="object-cover group-hover:scale-105 transition-transform duration-500"
                    referrerPolicy="no-referrer"
                  />
                  <span className="absolute top-3 left-3 bg-teal-900/80 backdrop-blur-xs text-teal-200 text-[10px] font-bold px-2.5 py-1 rounded-full">
                    Direct From Manufacturer
                  </span>
                  {count > 0 && (
                    <span className="absolute bottom-3 right-3 bg-slate-900/80 backdrop-blur-xs text-white text-[10px] font-bold px-2 py-0.5 rounded-md">
                      {count} items
                    </span>
                  )}
                </div>

                <div className="p-4 flex-1 flex flex-col justify-between">
                  <div>
                    <h3 className="font-bold text-base text-slate-900 dark:text-white">
                      {cat.name}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                      {cat.sub || `${cat.name} instruments and pro gear`}
                    </p>
                  </div>
                  <button
                    onClick={() => onSelectCategory(cat.id)}
                    className="mt-4 w-full bg-slate-900 hover:bg-teal-600 dark:bg-slate-800 dark:hover:bg-teal-600 text-white text-xs font-semibold py-2.5 rounded-xl transition cursor-pointer flex items-center justify-center gap-1"
                  >
                    <span>Browse Collection</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

// =========================================================
// 2. FAQS VIEW
// =========================================================
export function FAQsView({ onBack }: { onBack: () => void }) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const faqs = [
    {
      q: "Where is Drum Palace located in Uganda?",
      a: "Our main showroom and central distribution warehouse is located in Namungoona, Kampala, Uganda. We welcome in-person sound testing and gear auditions Monday through Saturday from 8:30 AM to 6:30 PM."
    },
    {
      q: "How fast is delivery within Kampala and upcountry Uganda?",
      a: "For Kampala and Entebbe orders, express dispatch arrives within 2 to 6 hours on the same day. For upcountry deliveries (Jinja, Mbarara, Gulu, Fort Portal, Mbale, etc.), shipments arrive securely via verified regional couriers within 24 to 48 hours."
    },
    {
      q: "What payment methods are supported?",
      a: "We accept MTN Mobile Money (MoMo), Airtel Money, Bank Wire Transfer, Visa / Mastercard credit cards, and Cash on Delivery (COD) for verified addresses in the greater Kampala metropolitan area."
    },
    {
      q: "Are the instruments genuine and backed by warranty?",
      a: "Yes, 100%. Every acoustic drum kit, electric guitar, PA speaker, and mixer sold by Drum Palace is authentic, brand-new, and comes with our standard 12-month manufacturer warranty and a 14-day replacement guarantee."
    },
    {
      q: "Can I request custom tuning or guitar setup before dispatch?",
      a: "Absolutely! Our in-house luthiers and percussion technicians provide free pro sound-checking, intonation setup, and drumhead pre-tensioning upon request before any package is dispatched."
    }
  ];

  return (
    <div className="min-h-screen bg-[#f8fafb] dark:bg-slate-950 text-slate-900 dark:text-slate-100 pb-20 animate-in fade-in duration-200">
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 px-4 h-16 flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-slate-800 dark:text-slate-200 font-bold text-sm hover:text-teal-600 dark:hover:text-teal-400 transition cursor-pointer"
        >
          <ArrowLeft size={18} />
          <span>Frequently Asked Questions</span>
        </button>
        <span className="text-xs font-semibold text-teal-600 dark:text-teal-400">
          Support & FAQs
        </span>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div className="mb-4">
          <h2 className="text-xl font-extrabold tracking-tight text-slate-900 dark:text-white">
            How can we help you today?
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Common questions regarding ordering, payment, shipping, and equipment guarantees.
          </p>
        </div>

        <div className="space-y-3">
          {faqs.map((faq, idx) => {
            const isOpen = openIndex === idx;
            return (
              <div
                key={idx}
                className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 overflow-hidden shadow-xs"
              >
                <button
                  onClick={() => setOpenIndex(isOpen ? null : idx)}
                  className="w-full p-4 flex items-center justify-between text-left font-bold text-sm text-slate-900 dark:text-white hover:text-teal-600 dark:hover:text-teal-400 transition cursor-pointer"
                >
                  <span>{faq.q}</span>
                  {isOpen ? <ChevronUp size={18} className="text-teal-600" /> : <ChevronDown size={18} className="text-slate-400" />}
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 pt-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed border-t border-slate-100 dark:border-slate-800/80">
                    {faq.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

// =========================================================
// 3. SHIPPING & RETURNS VIEW
// =========================================================
export function ShippingReturnsView({ onBack }: { onBack: () => void }) {
  return (
    <div className="min-h-screen bg-[#f8fafb] dark:bg-slate-950 text-slate-900 dark:text-slate-100 pb-20 animate-in fade-in duration-200">
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 px-4 h-16 flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-slate-800 dark:text-slate-200 font-bold text-sm hover:text-teal-600 dark:hover:text-teal-400 transition cursor-pointer"
        >
          <ArrowLeft size={18} />
          <span>Shipping & Returns</span>
        </button>
        <span className="text-xs font-semibold text-teal-600 dark:text-teal-400">
          Delivery Policy
        </span>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 dark:bg-teal-950 flex items-center justify-center text-teal-600">
              <Truck size={20} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">Uganda Shipping Guidelines</h3>
              <p className="text-xs text-slate-500">Fast, insured door-to-door delivery across the country.</p>
            </div>
          </div>

          <div className="text-xs text-slate-600 dark:text-slate-300 space-y-3 leading-relaxed border-t border-slate-100 dark:border-slate-800 pt-4">
            <p>
              • <strong>Kampala & Wakiso:</strong> Orders over UGX 500,000 qualify for FREE same-day delivery. Standard courier rate for smaller accessories is UGX 10,000.
            </p>
            <p>
              • <strong>Upcountry Regions:</strong> Daily secure parcel dispatches to Jinja, Mbarara, Gulu, Arua, Lira, Mbale, and Kabale. Dispatched orders are trackable via SMS.
            </p>
            <p>
              • <strong>Special Handling for Fragile Instruments:</strong> All guitars, drum shells, and stage speakers are double-boxed with high-density shock foam packaging.
            </p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 dark:bg-teal-950 flex items-center justify-center text-teal-600">
              <RotateCcw size={20} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">14-Day Return & Replacement Policy</h3>
              <p className="text-xs text-slate-500">Hassle-free guarantee on all authentic instruments.</p>
            </div>
          </div>

          <div className="text-xs text-slate-600 dark:text-slate-300 space-y-3 leading-relaxed border-t border-slate-100 dark:border-slate-800 pt-4">
            <p>
              • If you receive an item with any defect or shipping damage, notify our team within 14 days for a full replacement or prompt refund.
            </p>
            <p>
              • Items must be in their original packaging with warranty seals and included accessories intact.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

// =========================================================
// 4. ABOUT US VIEW
// =========================================================
export function AboutUsView({ onBack, onNavigate }: { onBack: () => void; onNavigate: (route: string) => void }) {
  return (
    <div className="min-h-screen bg-[#f8fafb] dark:bg-slate-950 text-slate-900 dark:text-slate-100 pb-20 animate-in fade-in duration-200">
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 px-4 h-16 flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-slate-800 dark:text-slate-200 font-bold text-sm hover:text-teal-600 dark:hover:text-teal-400 transition cursor-pointer"
        >
          <ArrowLeft size={18} />
          <span>About Drum Palace</span>
        </button>
        <span className="text-xs font-semibold text-teal-600 dark:text-teal-400">
          Est. 2024 · Uganda
        </span>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs space-y-4">
          <h2 className="text-xl font-extrabold text-slate-900 dark:text-white">
            East Africa&apos;s Premier Sound & Stage Hub
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            Founded with a passion for world-class musicianship and flawless live acoustics, <strong>Drum Palace</strong> is Uganda’s trusted destination for professional instruments, high-output stage lighting, church sound reinforcement, and recording studio gear.
          </p>

          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
            <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl">
              <span className="text-teal-600 font-extrabold text-lg block">1,500+</span>
              <span className="text-[11px] text-slate-500">Live Stage Productions Equipped</span>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl">
              <span className="text-teal-600 font-extrabold text-lg block">100%</span>
              <span className="text-[11px] text-slate-500">Original Certified Gear</span>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xs space-y-3">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Showroom & Workshop Location</h3>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            📍 Namungoona, Kampala - Hoima Road Junction, Uganda
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            📞 Phone / WhatsApp: +256 700 000 000 / +256 770 000 000
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            ✉️ Email: info@drumpalace.ug
          </p>

          <button
            onClick={() => onNavigate('contact')}
            className="mt-3 w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold transition cursor-pointer"
          >
            Get in Touch With Us
          </button>
        </div>
      </main>
    </div>
  );
}
