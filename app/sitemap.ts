import type { MetadataRoute } from 'next';

// APP_URL is the public site URL in production; the fallback keeps the sitemap
// pointed at the canonical Drum Palace domain if the variable is not configured.
const siteUrl = (process.env.APP_URL || 'https://drumpalace.top').replace(/\/+$/, '');

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      changeFrequency: 'daily',
      priority: 1,
    },
  ];
}
