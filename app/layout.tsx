import type { Metadata, Viewport } from 'next';
import { DM_Sans, Space_Grotesk } from 'next/font/google';
import './globals.css'; // Global styles

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans', display: 'swap' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk', display: 'swap' });

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
      <body className={`${dmSans.variable} ${spaceGrotesk.variable} font-sans`} suppressHydrationWarning>{children}</body>
    </html>
  );
}
