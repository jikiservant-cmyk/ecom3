export interface ProductItem {
  id: string;
  name: string;
  category: string;
  subtitle: string;
  price: number;
  /** Optional genuine "was" price. Absent means: no discount is being claimed. */
  originalPrice?: number;
  rating: number;
  reviewsCount: number;
  soldCount: string;
  image: string;
  images?: string[];
  description: string;
  badge?: string;
  specs: { [key: string]: string };
  soundProfile?: string;
  variants?: string[];
  /**
   * Real purchasable options, straight from public.product_variants. A customer
   * picks one and its id travels to the checkout API, which prices and stocks
   * that exact row. `variants` above is only a list of labels.
   */
  variantOptions?: ProductVariantOption[];
  freeShipping?: boolean;
}

export interface ProductVariantOption {
  id: string;
  label: string;
  /** Whole shillings, for display. The server always re-reads the real price. */
  price: number;
  inStock: boolean;
}

export interface CartItem {
  product: ProductItem;
  quantity: number;
  /** Label, for display. */
  selectedVariant?: string;
  /** The product_variants row that was chosen — this is what checkout sends. */
  variantId?: string;
}
