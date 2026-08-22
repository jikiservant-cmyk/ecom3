export interface ProductItem {
  id: string;
  name: string;
  category: string;
  subtitle: string;
  price: number;
  originalPrice: number;
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
  freeShipping?: boolean;
}

export interface CartItem {
  product: ProductItem;
  quantity: number;
  selectedVariant?: string;
}
