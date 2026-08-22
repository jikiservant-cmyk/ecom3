"use client";

import React from 'react';

interface LogoProps {
  className?: string;
  size?: number;
  showText?: boolean;
}

export function DrumPalaceLogo({ className = "", size = 64, showText = false }: LogoProps) {
  return (
    <div className={`inline-flex flex-col items-center select-none ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 160 160"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0 transition-transform duration-300 hover:scale-105"
      >
        {/* Outer and Inner Circle Rings */}
        <circle cx="80" cy="80" r="76" stroke="#049da4" strokeWidth="2.5" strokeDasharray="3 3" opacity="0.4" />
        <circle cx="80" cy="80" r="72" stroke="#049da4" strokeWidth="2.5" />
        <circle cx="80" cy="80" r="67" stroke="#049da4" strokeWidth="1.2" opacity="0.8" />
        <circle cx="80" cy="80" r="46" stroke="#049da4" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />

        {/* Curved Path Definition for Top Text */}
        <defs>
          <path id="curveTop" d="M 28 80 A 52 52 0 0 1 132 80" />
          <path id="curveBottom" d="M 132 80 A 52 52 0 0 1 28 80" />
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#049da4" floodOpacity="0.25" />
          </filter>
        </defs>

        {/* Top Arc Text: ALL ABOUT QUALITY */}
        <text
          fontSize="9.5"
          fontWeight="800"
          fill="#101a1b"
          letterSpacing="2.2"
          textAnchor="middle"
          className="dark:fill-teal-300"
        >
          <textPath href="#curveTop" startOffset="50%">
            ALL ABOUT QUALITY
          </textPath>
        </text>

        {/* Center Drum Kit Silhouette */}
        <g transform="translate(48, 50) scale(0.65)" stroke="#101a1b" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" fill="none" className="dark:stroke-teal-100">
          {/* Bass Drum */}
          <circle cx="50" cy="52" r="24" fill="#049da4" fillOpacity="0.12" stroke="#049da4" strokeWidth="3" />
          <circle cx="50" cy="52" r="19" stroke="#049da4" strokeWidth="1.5" strokeDasharray="3 2" />
          
          {/* Bass drum spurs */}
          <path d="M 28 66 L 16 78" strokeWidth="3" />
          <path d="M 72 66 L 84 78" strokeWidth="3" />

          {/* Snare Drum & High Tom */}
          <ellipse cx="22" cy="38" rx="14" ry="7" fill="#049da4" fillOpacity="0.1" />
          <path d="M 8 38 L 8 46 Q 22 53 36 46 L 36 38" />
          <line x1="22" y1="46" x2="22" y2="76" strokeWidth="2" />
          <path d="M 14 76 L 30 76" strokeWidth="2" />

          {/* Floor Tom */}
          <ellipse cx="78" cy="40" rx="14" ry="7" fill="#049da4" fillOpacity="0.1" />
          <path d="M 64 40 L 64 48 Q 78 55 92 48 L 92 40" />
          <line x1="78" y1="48" x2="78" y2="76" strokeWidth="2" />

          {/* Cymbals (Hi-Hat & Crash) */}
          <path d="M 6 22 Q 22 14 38 22" stroke="#049da4" strokeWidth="2.5" />
          <line x1="22" y1="18" x2="22" y2="38" strokeWidth="2" />

          <path d="M 62 18 Q 78 10 94 18" stroke="#049da4" strokeWidth="2.5" />
          <line x1="78" y1="14" x2="78" y2="40" strokeWidth="2" />

          {/* Drumsticks crossed */}
          <line x1="32" y1="28" x2="68" y2="60" stroke="#049da4" strokeWidth="2" />
          <line x1="68" y1="28" x2="32" y2="60" stroke="#049da4" strokeWidth="2" />
        </g>

        {/* DRUM PALACE Center Banner */}
        <rect x="20" y="106" width="120" height="22" rx="3" fill="#ffffff" stroke="#049da4" strokeWidth="1.5" className="dark:fill-slate-900" />
        <text
          x="80"
          y="121"
          textAnchor="middle"
          fontSize="12"
          fontWeight="900"
          letterSpacing="1.8"
          fill="#101a1b"
          className="dark:fill-white"
        >
          DRUM PALACE
        </text>

        {/* Bottom Arc Text: EST. 2024 */}
        <text
          fontSize="8.5"
          fontWeight="700"
          fill="#049da4"
          letterSpacing="3"
          textAnchor="middle"
        >
          <textPath href="#curveBottom" startOffset="50%">
            EST. 2024
          </textPath>
        </text>
      </svg>

      {showText && (
        <div className="text-center mt-2">
          <h2 className="text-base font-bold text-slate-900 dark:text-white leading-tight">Drum Palace</h2>
          <p className="text-[11px] font-semibold text-teal-600 dark:text-teal-400 mt-0.5">
            Premium Instruments & Pro Audio Gear
          </p>
          <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
            For Stage. For Studio. For You.
          </p>
        </div>
      )}
    </div>
  );
}
export default DrumPalaceLogo;
