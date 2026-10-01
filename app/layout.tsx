import type { Metadata, Viewport } from 'next';
import './globals.css'; // Global styles

// NOTE: custom web fonts were previously loaded via next/font/google, which made
// the production build depend on reaching fonts.googleapis.com. Builds must be
// hermetic, so the app now uses the system font fallback chain defined in
// globals.css (--font-dm-sans / --font-space-grotesk resolve to system-ui).

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#049da4',
};

export const metadata: Metadata = {
  title: 'Drum Palace — Premium Instruments & Pro Audio',
  description: 'Premium Instruments & Pro Audio Gear. For Stage. For Studio. For You.',
  openGraph: {
    title: 'Drum Palace — Premium Instruments & Pro Audio',
    description: 'Premium Instruments & Pro Audio Gear. For Stage. For Studio. For You.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Drum Palace — Premium Instruments & Pro Audio',
    description: 'Premium Instruments & Pro Audio Gear. For Stage. For Studio. For You.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body className="font-sans" suppressHydrationWarning>{children}</body>
    </html>
  );
}
