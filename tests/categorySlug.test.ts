import { describe, expect, it } from 'vitest';
import { slugifyCategoryName } from '../lib/supabaseDb';

describe('slugifyCategoryName', () => {
  it('creates stable lowercase slugs for category names', () => {
    expect(slugifyCategoryName('DJ Equipment')).toBe('dj-equipment');
    expect(slugifyCategoryName('Mixers & Audio')).toBe('mixers-audio');
  });

  it('removes accents and trims punctuation', () => {
    expect(slugifyCategoryName('Café & Stage Gear!')).toBe('cafe-stage-gear');
    expect(slugifyCategoryName('Crème')).toBe('creme');
    expect(slugifyCategoryName('   !!!   ')).toBe('');
  });
});
