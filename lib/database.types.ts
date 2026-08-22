export type UserRole = 'customer' | 'admin' | 'staff';
export type ProductStatus = 'draft' | 'active' | 'archived';
export type VariantStatus = 'active' | 'draft' | 'out_of_stock';
export type OrderStatus = 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
export type PaymentStatus = 'pending' | 'success' | 'failed' | 'refunded';

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string | null;
          phone: string | null;
          role: UserRole;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          full_name?: string | null;
          phone?: string | null;
          role?: UserRole;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          full_name?: string | null;
          phone?: string | null;
          role?: UserRole;
          created_at?: string;
          updated_at?: string;
        };
      };
      categories: {
        Row: {
          id: string;
          name: string;
          slug: string;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      products: {
        Row: {
          id: string;
          name: string;
          slug: string;
          description: string | null;
          category_id: string | null;
          status: ProductStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          description?: string | null;
          category_id?: string | null;
          status?: ProductStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          description?: string | null;
          category_id?: string | null;
          status?: ProductStatus;
          created_at?: string;
          updated_at?: string;
        };
      };
      product_variants: {
        Row: {
          id: string;
          product_id: string;
          sku: string;
          attributes: Json;
          price_minor_units: number;
          currency: string;
          inventory_quantity: number;
          status: VariantStatus;
          position: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          product_id: string;
          sku: string;
          attributes?: Json;
          price_minor_units: number;
          currency?: string;
          inventory_quantity?: number;
          status?: VariantStatus;
          position?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          product_id?: string;
          sku?: string;
          attributes?: Json;
          price_minor_units?: number;
          currency?: string;
          inventory_quantity?: number;
          status?: VariantStatus;
          position?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
      product_images: {
        Row: {
          id: string;
          product_id: string;
          storage_path: string;
          alt_text: string | null;
          position: number;
          is_primary: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          product_id: string;
          storage_path: string;
          alt_text?: string | null;
          position?: number;
          is_primary?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          product_id?: string;
          storage_path?: string;
          alt_text?: string | null;
          position?: number;
          is_primary?: boolean;
          created_at?: string;
        };
      };
      carts: {
        Row: {
          id: string;
          customer_id: string | null;
          session_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          customer_id?: string | null;
          session_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          customer_id?: string | null;
          session_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      cart_items: {
        Row: {
          id: string;
          cart_id: string;
          variant_id: string;
          quantity: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          cart_id: string;
          variant_id: string;
          quantity: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          cart_id?: string;
          variant_id?: string;
          quantity?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
      orders: {
        Row: {
          id: string;
          order_number: string;
          customer_id: string | null;
          customer_email: string;
          customer_name: string | null;
          customer_phone: string | null;
          shipping_address: Json | null;
          status: OrderStatus;
          currency: string;
          subtotal_minor_units: number;
          discount_minor_units: number;
          shipping_minor_units: number;
          tax_minor_units: number;
          total_minor_units: number;
          reservation_expires_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          order_number: string;
          customer_id?: string | null;
          customer_email: string;
          customer_name?: string | null;
          customer_phone?: string | null;
          shipping_address?: Json | null;
          status?: OrderStatus;
          currency?: string;
          subtotal_minor_units: number;
          discount_minor_units?: number;
          shipping_minor_units?: number;
          tax_minor_units?: number;
          total_minor_units: number;
          reservation_expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          order_number?: string;
          customer_id?: string | null;
          customer_email?: string;
          customer_name?: string | null;
          customer_phone?: string | null;
          shipping_address?: Json | null;
          status?: OrderStatus;
          currency?: string;
          subtotal_minor_units?: number;
          discount_minor_units?: number;
          shipping_minor_units?: number;
          tax_minor_units?: number;
          total_minor_units?: number;
          reservation_expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      order_items: {
        Row: {
          id: string;
          order_id: string;
          product_id: string | null;
          variant_id: string | null;
          product_name: string;
          product_slug: string;
          variant_sku: string;
          variant_attributes: Json;
          unit_price_minor_units: number;
          quantity: number;
          line_total_minor_units: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          order_id: string;
          product_id?: string | null;
          variant_id?: string | null;
          product_name: string;
          product_slug: string;
          variant_sku: string;
          variant_attributes?: Json;
          unit_price_minor_units: number;
          quantity: number;
          line_total_minor_units: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          order_id?: string;
          product_id?: string | null;
          variant_id?: string | null;
          product_name?: string;
          product_slug?: string;
          variant_sku?: string;
          variant_attributes?: Json;
          unit_price_minor_units?: number;
          quantity?: number;
          line_total_minor_units?: number;
          created_at?: string;
        };
      };
      payments: {
        Row: {
          id: string;
          order_id: string;
          provider: string;
          provider_reference: string;
          status: PaymentStatus;
          amount_minor_units: number;
          currency: string;
          raw_payload: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          order_id: string;
          provider: string;
          provider_reference: string;
          status?: PaymentStatus;
          amount_minor_units: number;
          currency?: string;
          raw_payload?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          order_id?: string;
          provider?: string;
          provider_reference?: string;
          status?: PaymentStatus;
          amount_minor_units?: number;
          currency?: string;
          raw_payload?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      payment_webhook_events: {
        Row: {
          id: string;
          provider: string;
          event_id: string;
          payment_id: string | null;
          payload: Json;
          processed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          provider: string;
          event_id: string;
          payment_id?: string | null;
          payload: Json;
          processed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          provider?: string;
          event_id?: string;
          payment_id?: string | null;
          payload?: Json;
          processed_at?: string | null;
          created_at?: string;
        };
      };
    };
  };
}
