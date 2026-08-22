"use client";

import { useRef, useState, useEffect } from "react";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { ProductItem } from "@/lib/types";
import AliExpressProductCard from "./AliExpressProductCard";

interface HorizontalProductSliderProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  tag?: string;
  tagColor?: "red" | "blue" | "emerald" | "amber" | "indigo";
  products: ProductItem[];
  wishlist: string[];
  onToggleWishlist: (productId: string, e?: React.MouseEvent) => void;
  onAddToBag: (product: ProductItem, variant?: string, e?: React.MouseEvent) => void;
  onOpenModal: (product: ProductItem) => void;
  onViewAll?: () => void;
  viewAllLabel?: string;
  currency?: string;
}

export default function HorizontalProductSlider({
  title,
  subtitle,
  icon,
  tag,
  tagColor = "red",
  products,
  wishlist,
  onToggleWishlist,
  onAddToBag,
  onOpenModal,
  onViewAll,
  viewAllLabel = "View all",
  currency = "UGX"
}: HorizontalProductSliderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const [scrollProgress, setScrollProgress] = useState(0);

  const checkScrollState = () => {
    if (!scrollRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
    setCanScrollLeft(scrollLeft > 10);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 10);
    
    const maxScroll = scrollWidth - clientWidth;
    if (maxScroll > 0) {
      setScrollProgress(Math.min(100, Math.max(0, (scrollLeft / maxScroll) * 100)));
    }
  };

  useEffect(() => {
    checkScrollState();
    const el = scrollRef.current;
    if (el) {
      el.addEventListener("scroll", checkScrollState, { passive: true });
      window.addEventListener("resize", checkScrollState);
    }
    return () => {
      if (el) el.removeEventListener("scroll", checkScrollState);
      window.removeEventListener("resize", checkScrollState);
    };
  }, [products]);

  const handleScroll = (direction: "left" | "right") => {
    if (!scrollRef.current) return;
    const scrollAmount = 620; // scrolls ~2 cards smoothly
    scrollRef.current.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth"
    });
  };

  const getTagClasses = () => {
    switch (tagColor) {
      case "red":
        return "bg-[#ffebe8] text-[#ff4747] border-[#ffc7c0]";
      case "blue":
        return "bg-sky-50 text-[#0071e3] border-sky-200";
      case "emerald":
        return "bg-emerald-50 text-emerald-600 border-emerald-200";
      case "amber":
        return "bg-amber-50 text-amber-600 border-amber-200";
      case "indigo":
        return "bg-indigo-50 text-indigo-600 border-indigo-200";
      default:
        return "bg-black/5 text-black/70 border-black/10";
    }
  };

  return (
    <div className="w-full py-8">
      {/* HEADER SECTION */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-6 gap-4">
        <div>
          {tag && (
            <div className="flex items-center gap-2 mb-2">
              <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-bold tracking-wide uppercase ${getTagClasses()}`}>
                {icon || <Sparkles size={11} />}
                {tag}
              </span>
              <span className="text-[11px] font-medium text-black/40">
                ({products.length} instruments)
              </span>
            </div>
          )}

          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#1d1d1f]">
            {title}
          </h2>

          {subtitle && (
            <p className="mt-1 text-xs sm:text-sm text-black/55">
              {subtitle}
            </p>
          )}
        </div>

        {/* NAVIGATION CONTROLS & VIEW ALL */}
        <div className="flex items-center gap-3 self-end sm:self-auto">
          {onViewAll && (
            <button
              onClick={onViewAll}
              className="text-xs font-semibold text-[#0071e3] hover:underline flex items-center gap-0.5 mr-2"
            >
              <span>{viewAllLabel}</span>
              <ChevronRight size={14} />
            </button>
          )}

          {/* Left / Right Arrow Buttons */}
          <div className="flex items-center gap-1.5 bg-[#f5f5f7] p-1 rounded-full border border-black/[0.06]">
            <button
              onClick={() => handleScroll("left")}
              disabled={!canScrollLeft}
              aria-label="Previous instruments"
              className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
                canScrollLeft
                  ? "bg-white text-black shadow-sm hover:bg-black hover:text-white"
                  : "text-black/25 cursor-not-allowed opacity-50"
              }`}
            >
              <ChevronLeft size={16} />
            </button>

            <button
              onClick={() => handleScroll("right")}
              disabled={!canScrollRight}
              aria-label="Next instruments"
              className={`flex h-8 w-8 items-center justify-center rounded-full transition ${
                canScrollRight
                  ? "bg-white text-black shadow-sm hover:bg-black hover:text-white"
                  : "text-black/25 cursor-not-allowed opacity-50"
              }`}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* HORIZONTAL SCROLLER CONTAINER */}
      <div className="relative">
        <div
          ref={scrollRef}
          className="flex gap-5 overflow-x-auto pb-5 pt-2 scroll-smooth snap-x snap-mandatory scrollbar-none [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ scrollbarWidth: "none" }}
        >
          {products.map((product) => (
            <AliExpressProductCard
              key={product.id}
              product={product}
              isWishlisted={wishlist.includes(product.id)}
              onToggleWishlist={onToggleWishlist}
              onAddToBag={onAddToBag}
              onOpenModal={onOpenModal}
              layoutMode="slider"
              currency={currency}
            />
          ))}
        </div>

        {/* SUBTLE SCROLL PROGRESS BAR */}
        <div className="mt-3 flex items-center justify-between px-1">
          <div className="h-1 w-32 rounded-full bg-black/10 overflow-hidden">
            <div
              className="h-full bg-[#1d1d1f] transition-all duration-200"
              style={{ width: `${Math.max(15, scrollProgress)}%` }}
            />
          </div>
          <span className="text-[10px] font-medium text-black/40">
            Slide horizontally to explore {products.length} items &rarr;
          </span>
        </div>
      </div>
    </div>
  );
}
