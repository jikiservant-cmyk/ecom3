"use client";

import React, { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { BannerSlide, DEFAULT_BANNER_SLIDES, getStoreSettings } from '@/lib/storeSettings';

interface SonusBannerProps {
  slides?: BannerSlide[];
  onNavigateToShop?: (filter?: string) => void;
}

export function SonusBanner({ slides: propSlides, onNavigateToShop }: SonusBannerProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const activeSlides = propSlides && propSlides.length > 0 ? propSlides : DEFAULT_BANNER_SLIDES;
  const totalSlides = activeSlides.length;
  const safeSlideIndex = totalSlides > 0 ? currentSlide % totalSlides : 0;

  const nextSlide = useCallback(() => {
    if (totalSlides === 0) return;
    setCurrentSlide((prev) => (prev + 1) % totalSlides);
  }, [totalSlides]);

  const prevSlide = useCallback(() => {
    if (totalSlides === 0) return;
    setCurrentSlide((prev) => (prev - 1 + totalSlides) % totalSlides);
  }, [totalSlides]);

  // Auto-advance timer (every 4.5 seconds)
  useEffect(() => {
    if (isPaused || totalSlides <= 1) return;
    const interval = setInterval(() => {
      nextSlide();
    }, 4500);
    return () => clearInterval(interval);
  }, [isPaused, nextSlide, totalSlides]);

  if (!activeSlides || activeSlides.length === 0) {
    return null;
  }

  return (
    <div
      className="relative w-full h-[220px] xs:h-[250px] sm:h-[290px] md:h-[340px] lg:h-[380px] overflow-hidden bg-black select-none group"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      role="region"
      aria-label="Promotional Banner Carousel"
    >
      {/* Banner Slides Track */}
      <div
        className="flex w-full h-full transition-transform duration-700 ease-in-out"
        style={{
          transform: `translateX(-${safeSlideIndex * 100}%)`,
        }}
      >
        {activeSlides.map((slide, index) => (
          <div
            key={slide.id || `slide-${index}`}
            className="w-full h-full shrink-0 relative flex items-end justify-start p-4 xs:p-6 sm:p-8 md:p-12 cursor-pointer"
            onClick={() => onNavigateToShop && onNavigateToShop(slide.categoryFilter || 'all')}
          >
            {/* Background Image with Next.js Image optimization and brightness filter */}
            <div className="absolute inset-0 z-0">
              <Image
                src={slide.image}
                alt={slide.caption}
                fill
                priority={index === 0}
                referrerPolicy="no-referrer"
                className="object-cover brightness-75 transition-transform duration-700 group-hover:scale-105"
              />
              {/* Gradient Overlay for enhanced text readability */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
            </div>

            {/* Slide Content Caption */}
            <div className="relative z-10 max-w-xl text-left animate-in fade-in slide-in-from-bottom-3 duration-500">
              <h2
                className="text-xl xs:text-2xl sm:text-3xl md:text-4xl lg:text-[40px] font-extrabold text-white tracking-tight leading-tight"
                style={{ textShadow: '0 2px 8px rgba(0,0,0,0.6)' }}
              >
                {slide.caption}
              </h2>
              {slide.subtext && (
                <p
                  className="mt-1 text-xs sm:text-sm md:text-base font-medium text-slate-200 line-clamp-2 opacity-90"
                  style={{ textShadow: '0 1px 4px rgba(0,0,0,0.7)' }}
                >
                  {slide.subtext}
                </p>
              )}
              {slide.ctaText && (
                <div className="mt-2.5 sm:mt-3.5 inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 rounded-full bg-[#049da4] hover:bg-[#03848a] text-white text-xs sm:text-sm font-bold shadow-lg transition">
                  <span>{slide.ctaText}</span>
                  <span className="text-xs sm:text-sm">→</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Left Navigation Arrow */}
      {totalSlides > 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            prevSlide();
          }}
          aria-label="Previous Slide"
          className="absolute top-1/2 -translate-y-1/2 left-3 sm:left-4 z-20 w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/80 hover:bg-white text-slate-900 shadow-md flex items-center justify-center text-xl font-bold cursor-pointer transition transform active:scale-95"
        >
          ‹
        </button>
      )}

      {/* Right Navigation Arrow */}
      {totalSlides > 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            nextSlide();
          }}
          aria-label="Next Slide"
          className="absolute top-1/2 -translate-y-1/2 right-3 sm:right-4 z-20 w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/80 hover:bg-white text-slate-900 shadow-md flex items-center justify-center text-xl font-bold cursor-pointer transition transform active:scale-95"
        >
          ›
        </button>
      )}

      {/* Slide Navigation Dots */}
      {totalSlides > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2">
          {activeSlides.map((_, index) => (
            <button
              key={index}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCurrentSlide(index);
              }}
              aria-label={`Go to slide ${index + 1}`}
              className={`transition-all duration-300 rounded-full cursor-pointer ${
                safeSlideIndex === index
                  ? 'w-6 sm:w-8 h-2 bg-[#049da4]'
                  : 'w-2 h-2 bg-white/50 hover:bg-white/80'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default SonusBanner;
