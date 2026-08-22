"use client";

import Image from "next/image";
import { 
  Zap, 
  ShieldCheck, 
  Flame, 
  Heart, 
  ShoppingBag, 
  Eye
} from "lucide-react";
import { ProductItem } from "@/lib/types";
import { formatMoney } from "@/lib/utils";

interface AliExpressProductCardProps {
  product: ProductItem;
  isWishlisted: boolean;
  onToggleWishlist: (productId: string, e?: React.MouseEvent) => void;
  onAddToBag: (product: ProductItem, variant?: string, e?: React.MouseEvent) => void;
  onOpenModal: (product: ProductItem) => void;
  layoutMode?: "slider" | "grid";
  currency?: string;
}

export default function AliExpressProductCard({
  product,
  isWishlisted,
  onToggleWishlist,
  onAddToBag,
  onOpenModal,
  layoutMode = "grid",
  currency = "UGX"
}: AliExpressProductCardProps) {
  const currentFormatted = formatMoney(product.price, currency);
  const oldFormatted = product.originalPrice > product.price ? formatMoney(product.originalPrice, currency) : undefined;
  const priceFormatted = {
    current: currentFormatted,
    old: oldFormatted,
  };

  return (
    <div
      onClick={() => onOpenModal(product)}
      className={`group relative flex flex-col justify-between overflow-hidden rounded-[8px] border border-[#eee] bg-white transition-all duration-200 hover:shadow-[0_4px_14px_rgba(0,0,0,0.12)] cursor-pointer select-none ${
        layoutMode === "slider"
          ? "w-[210px] sm:w-[220px] md:w-[230px] flex-shrink-0 snap-start"
          : "w-full"
      }`}
    >
      {/* 1. PRODUCT IMAGE CONTAINER (180px height as per specification) */}
      <div className="relative w-full h-[180px] overflow-hidden bg-[#f8f8f8]">
        {/* BADGES (Choice / Top Brand / Hot Deal / Artisan) */}
        <div className="absolute left-2.5 top-2.5 z-10 flex flex-col gap-1 pointer-events-none">
          {product.badge === "Choice" && (
            <span className="flex items-center gap-1 rounded-[4px] bg-[#ff4747] px-2 py-0.5 text-[10px] font-bold tracking-wider text-white shadow-sm uppercase">
              <Zap size={10} className="fill-white" />
              Choice
            </span>
          )}
          {product.badge === "Top Brand" && (
            <span className="flex items-center gap-1 rounded-[4px] bg-[#1a1a1a] px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
              <ShieldCheck size={10} className="text-amber-400" />
              Top Brand
            </span>
          )}
          {product.badge === "Hot Deal" && (
            <span className="flex items-center gap-1 rounded-[4px] bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
              <Flame size={10} className="fill-white" />
              Hot Deal
            </span>
          )}
          {product.badge === "Bestseller" && (
            <span className="flex items-center gap-1 rounded-[4px] bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
              ★ Bestseller
            </span>
          )}
          {product.badge === "Artisan" && (
            <span className="rounded-[4px] bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
              Artisan
            </span>
          )}
        </div>

        {/* WISHLIST BUTTON */}
        <button
          type="button"
          onClick={(e) => onToggleWishlist(product.id, e)}
          aria-label="Add to wishlist"
          className="absolute right-2.5 top-2.5 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 shadow-sm backdrop-blur-sm transition hover:scale-110 hover:bg-white cursor-pointer"
        >
          <Heart
            size={14}
            className={`transition ${isWishlisted ? "fill-rose-500 text-rose-500" : "text-black/45 hover:text-black"}`}
          />
        </button>

        {/* MAIN PRODUCT IMAGE */}
        <Image
          src={product.image}
          alt={product.name}
          fill
          sizes="(max-width: 768px) 220px, 260px"
          referrerPolicy="no-referrer"
          className="object-cover transition-transform duration-300 ease-out group-hover:scale-105"
        />

        {/* HOVER QUICK ACTION BAR */}
        <div className="absolute inset-x-2 bottom-2 z-10 opacity-0 transition-all duration-200 group-hover:opacity-100 flex gap-1.5 pointer-events-none">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddToBag(product, undefined, e);
            }}
            className="flex-1 pointer-events-auto flex items-center justify-center gap-1 rounded-md bg-[#1a1a1a]/95 py-1.5 px-2 text-[11px] font-bold text-white shadow-md backdrop-blur-sm hover:bg-[#ff4747] transition-colors cursor-pointer"
            title="Quick Add to Bag"
          >
            <ShoppingBag size={12} />
            <span>Add</span>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenModal(product);
            }}
            className="pointer-events-auto flex items-center justify-center rounded-md bg-white/95 p-1.5 text-black/75 shadow-md backdrop-blur-sm hover:bg-white hover:text-black transition-colors cursor-pointer"
            title="View Specs"
          >
            <Eye size={13} />
          </button>
        </div>
      </div>

      {/* 2. PRODUCT INFO CONTAINER (padding: 12px) */}
      <div className="p-3 flex flex-1 flex-col justify-between">
        <div>
          {/* PRODUCT NAME / TITLE */}
          <h3 
            className="text-[13px] font-medium text-[#1a1a1a] line-clamp-1 leading-snug group-hover:text-[#ff4747] transition-colors"
            title={product.name}
          >
            {product.name}
          </h3>

          {/* PRICE ROW */}
          <div className="mt-1 flex items-baseline flex-wrap">
            <span className="text-[17px] font-bold text-[#1a1a1a] tracking-tight leading-none">
              {priceFormatted.current}
            </span>
            {priceFormatted.old && (
              <span className="text-[12px] text-[#999] line-through ml-1.5 font-normal">
                {priceFormatted.old}
              </span>
            )}
          </div>

          {/* RATING & SOLD COUNT ROW */}
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-[#555]">
            <span className="text-[#ffb300] font-bold text-[13px]">★</span>
            <span className="font-semibold text-black/80">{product.rating.toFixed(1)}</span>
            <span className="text-black/30">&nbsp;|&nbsp;</span>
            <span>{product.soldCount}</span>
          </div>
        </div>

        {/* FREE SHIPPING / EXTRA VALUE TAG */}
        <div className="mt-2 pt-1.5 border-t border-[#f0f0f0] flex items-center justify-between text-[10px] text-black/55">
          <span className="text-emerald-600 font-medium truncate">
            {product.freeShipping ? "Free Shipping" : "Fast Delivery"}
          </span>
          <span className="text-black/40 uppercase tracking-wider text-[9px] font-semibold">
            {product.category}
          </span>
        </div>
      </div>
    </div>
  );
}

