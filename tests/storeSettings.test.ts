import { describe, expect, it } from 'vitest';
import { DEFAULT_STORE_SETTINGS, normalizeStoreSettings } from '../lib/storeSettings';

describe('normalizeStoreSettings', () => {
  it('updates contact details in settings saved before the current contact-info version', () => {
    const normalized = normalizeStoreSettings({
      ...DEFAULT_STORE_SETTINGS,
      contactInfoVersion: undefined,
      contactPhone: '+256700000000',
      contactWhatsapp: '+256770000000',
      contactEmail: 'info@drumpalace.ug',
      contactAddress: 'Old Kampala address',
    });

    expect(normalized.contactPhone).toBe('+256767733061');
    expect(normalized.contactWhatsapp).toBe('+256767733061');
    expect(normalized.contactEmail).toBe('digifted464@gmail.com');
    expect(normalized.contactAddress).toBe('Namungoona-Kuluyinja, Kampala - Uganda');
  });

  it('preserves contact details saved after the current contact-info version', () => {
    const normalized = normalizeStoreSettings({
      ...DEFAULT_STORE_SETTINGS,
      contactInfoVersion: 1,
      contactPhone: '+256701234567',
      contactWhatsapp: '+256701234567',
    });

    expect(normalized.contactPhone).toBe('+256701234567');
    expect(normalized.contactWhatsapp).toBe('+256701234567');
  });
});
