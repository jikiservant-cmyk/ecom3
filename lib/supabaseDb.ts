import { supabase, isSupabaseConfigured, getActiveSupabaseConfig } from './supabase';
import { ProductItem } from './types';

const ORDER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Cryptographically random, collision-resistant order number (DP-XXXX-XXXX). */
export function generateSecureOrderNumber(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < 8; i++) out += ORDER_ALPHABET[bytes[i] % ORDER_ALPHABET.length];
  return `DP-${out.slice(0, 4)}-${out.slice(4)}`;
}

export interface DbOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  items: { productName: string; quantity: number; price: number; variant?: string }[];
  total: number;
  status: 'Pending' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled';
  paymentStatus: 'Paid' | 'Pending' | 'Failed';
  createdAt: string;
  shippingAddress?: string;
  /** How the customer is paying. COD orders must not be mistaken for unpaid ones. */
  paymentMethod?: 'momo' | 'cod';
  /** Carrier reference, set when the admin marks the order Shipped. */
  trackingNumber?: string;
}

export interface DbUserProfile {
  id: string;
  email: string;
  name: string;
  phone?: string;
  role: 'admin' | 'staff' | 'customer';
  created_at?: string;
}

export interface DbCategory {
  id: string;
  name: string;
  slug: string;
  description?: string;
  image?: string;
}

export interface DbReview {
  id: string;
  productId: string;
  userName: string;
  userEmail?: string;
  rating: number;
  comment: string;
  createdAt: string;
  verifiedPurchase: boolean;
}

// UUID Utility Functions

/**
 * Check if a string is a valid RFC4122 UUID
 */
export function isValidUuid(str?: string | null): boolean {
  if (!str || typeof str !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str.trim());
}

/**
 * Generate a cryptographically strong UUID v4
 */
export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Ensures any string ID is transformed into a valid UUID accepted by PostgreSQL uuid column type.
 * If already a valid UUID, returns as is.
 * If not (e.g. 'dp_1787388153433' or 'g-1'), turns it into a deterministic, RFC4122-compliant UUID.
 */
export function ensureValidUuid(id?: string | null): string {
  if (id && isValidUuid(id)) {
    return id.trim().toLowerCase();
  }
  if (!id || typeof id !== 'string') {
    return generateUuid();
  }
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < id.length; i++) {
    const ch = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  
  const p1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const p2 = (h2 >>> 16).toString(16).padStart(4, '0');
  const p3 = '4' + ((h2 & 0x0fff) >>> 0).toString(16).padStart(3, '0');
  const p4 = ((0x8000 | (h1 & 0x3fff)) >>> 0).toString(16).padStart(4, '0');
  const p5 = ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
  
  return `${p1}-${p2}-${p3}-${p4}-${p5}`.toLowerCase();
}

/**
 * Strictly fetch all products directly from the database (the single source of truth).
 * Aligned with normalized schema (Option A):
 * - public.products (id, name, slug, description, category_id, status, created_at, updated_at)
 * - public.product_variants (id, product_id, sku, attributes, price_minor_units, currency, inventory_quantity, status)
 * - public.product_images (id, product_id, storage_path, alt_text, is_primary, position)
 * - public.categories (id, name, slug)
 */
export async function getProductsFromDb(): Promise<ProductItem[]> {
  try {
    // 1. First attempt: Normalized relational query (products + product_variants + product_images + categories)
    const { data: normalizedProducts, error: normErr } = await (supabase.from('products') as any)
      .select(`
        id,
        name,
        slug,
        description,
        category_id,
        status,
        created_at,
        product_variants (
          id,
          sku,
          attributes,
          price_minor_units,
          currency,
          inventory_quantity,
          status,
          position
        ),
        product_images (
          id,
          storage_path,
          alt_text,
          is_primary,
          position
        ),
        categories (
          id,
          name,
          slug
        )
      `)
      .order('created_at', { ascending: false });

    if (!normErr && Array.isArray(normalizedProducts) && normalizedProducts.length > 0) {
      return normalizedProducts.map((p: any) => {
        const sortedVariants = Array.isArray(p.product_variants)
          ? [...p.product_variants].sort((a: any, b: any) => (a.position || 0) - (b.position || 0))
          : [];
        const primaryVariant = sortedVariants[0];

        const sortedImages = Array.isArray(p.product_images)
          ? [...p.product_images].sort((a: any, b: any) => {
              if (a.is_primary && !b.is_primary) return -1;
              if (!a.is_primary && b.is_primary) return 1;
              return (a.position || 0) - (b.position || 0);
            })
          : [];
        const primaryImage = sortedImages.find((img: any) => img.is_primary) || sortedImages[0];
        const secondaryImages = sortedImages.filter((img: any) => img !== primaryImage).map((img: any) => img.storage_path);

        const rawPrice = primaryVariant?.price_minor_units
          ? Number(primaryVariant.price_minor_units) / 100
          : 0;

        const categoryName = p.categories?.name || 'Instruments';
        const attributes = (primaryVariant?.attributes && typeof primaryVariant.attributes === 'object')
          ? primaryVariant.attributes
          : {};

        const parsedVariants = Array.isArray(attributes.variants) && attributes.variants.length > 0
          ? attributes.variants
          : (sortedVariants.length > 0 ? sortedVariants.map((v: any) => v.sku || 'Standard') : ['Standard']);

        const parsedSpecs = attributes.specs && typeof attributes.specs === 'object'
          ? attributes.specs
          : {};

        const soundProfile = attributes.soundProfile || 'High Definition Audio';
        const badge = attributes.badge || undefined;
        const freeShipping = attributes.freeShipping !== false;
        const originalPrice = attributes.originalPrice ? Number(attributes.originalPrice) : Math.round(rawPrice * 1.25);
        const rating = attributes.rating ? Number(attributes.rating) : 4.9;
        const reviewsCount = attributes.reviewsCount ? Number(attributes.reviewsCount) : 0;
        const soldCount = attributes.soldCount || 'In Stock';

        return {
          id: p.id,
          name: p.name || 'Instrument',
          category: categoryName,
          subtitle: p.description || '',
          price: rawPrice,
          originalPrice,
          rating,
          reviewsCount,
          soldCount,
          image: primaryImage?.storage_path || 'https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=800&q=85',
          images: secondaryImages.length > 0 ? secondaryImages : undefined,
          badge,
          description: p.description || '',
          specs: parsedSpecs,
          soundProfile,
          variants: parsedVariants,
          freeShipping,
        };
      });
    }

    // 2. Direct individual table queries (if PostgREST relationship cache wasn't linked)
    const { data: rawProducts, error: prodErr } = await (supabase.from('products') as any)
      .select('*')
      .order('created_at', { ascending: false });

    if (!prodErr && Array.isArray(rawProducts) && rawProducts.length > 0) {
      const prodIds = rawProducts.map((p: any) => p.id);
      const [{ data: rawVariants }, { data: rawImages }, { data: rawCats }] = await Promise.all([
        (supabase.from('product_variants') as any).select('*').in('product_id', prodIds),
        (supabase.from('product_images') as any).select('*').in('product_id', prodIds),
        (supabase.from('categories') as any).select('*'),
      ]);

      const catMap = new Map<string, string>();
      if (Array.isArray(rawCats)) {
        rawCats.forEach((c: any) => catMap.set(c.id, c.name));
      }

      return rawProducts.map((p: any) => {
        const variants = (rawVariants || []).filter((v: any) => v.product_id === p.id);
        const images = (rawImages || []).filter((img: any) => img.product_id === p.id);
        const primaryVariant = variants[0];
        const primaryImg = images.find((i: any) => i.is_primary) || images[0];
        const secondaryImgs = images.filter((i: any) => i !== primaryImg).map((i: any) => i.storage_path);
        const rawPrice = primaryVariant?.price_minor_units ? Number(primaryVariant.price_minor_units) / 100 : 0;
        const attributes = primaryVariant?.attributes || {};

        return {
          id: p.id,
          name: p.name || 'Instrument',
          category: catMap.get(p.category_id) || 'Instruments',
          subtitle: p.description || '',
          price: rawPrice,
          originalPrice: attributes.originalPrice || Math.round(rawPrice * 1.25),
          rating: attributes.rating || 4.9,
          reviewsCount: attributes.reviewsCount || 0,
          soldCount: attributes.soldCount || 'In Stock',
          image: primaryImg?.storage_path || 'https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=800&q=85',
          images: secondaryImgs.length > 0 ? secondaryImgs : undefined,
          badge: attributes.badge || undefined,
          description: p.description || '',
          specs: attributes.specs || {},
          soundProfile: attributes.soundProfile || 'High Definition Audio',
          variants: attributes.variants || ['Standard'],
          freeShipping: attributes.freeShipping !== false,
        };
      });
    }
  } catch (err) {
    console.error('Database product query error:', err);
  }

  // Return real database products only (empty array if no records in database)
  return [];
}

/**
 * Fetch a single product by ID directly from the database (Option A Normalized)
 */
export async function getProductByIdFromDb(productId: string): Promise<ProductItem | null> {
  try {
    const validId = ensureValidUuid(productId);
    const { data, error } = await (supabase.from('products') as any)
      .select(`
        id,
        name,
        slug,
        description,
        category_id,
        status,
        created_at,
        product_variants (
          id,
          sku,
          attributes,
          price_minor_units,
          currency,
          inventory_quantity,
          status
        ),
        product_images (
          id,
          storage_path,
          alt_text,
          is_primary,
          position
        ),
        categories (
          id,
          name,
          slug
        )
      `)
      .or(`id.eq.${validId},id.eq.${productId},slug.eq.${productId}`)
      .maybeSingle();

    if (!error && data) {
      const primaryVariant = data.product_variants?.[0];
      const primaryImage = data.product_images?.find((img: any) => img.is_primary) || data.product_images?.[0];
      const secondaryImages = data.product_images?.filter((img: any) => !img.is_primary).map((img: any) => img.storage_path) || [];
      const rawPrice = primaryVariant?.price_minor_units ? Number(primaryVariant.price_minor_units) / 100 : 0;
      const attributes = primaryVariant?.attributes || {};

      return {
        id: data.id,
        name: data.name,
        category: data.categories?.name || 'Instruments',
        subtitle: data.description || '',
        price: rawPrice,
        originalPrice: attributes.originalPrice || Math.round(rawPrice * 1.25),
        rating: attributes.rating || 4.9,
        reviewsCount: attributes.reviewsCount || 0,
        soldCount: attributes.soldCount || 'In Stock',
        image: primaryImage?.storage_path || 'https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=800&q=85',
        images: secondaryImages.length > 0 ? secondaryImages : undefined,
        description: data.description || '',
        badge: attributes.badge || undefined,
        specs: attributes.specs || {},
        soundProfile: attributes.soundProfile || 'High Definition Audio',
        variants: attributes.variants || ['Standard'],
        freeShipping: attributes.freeShipping !== false,
      };
    }
  } catch (err) {
    console.error('Single product database fetch notice:', err);
  }

  return null;
}

/**
 * Fetch dynamic categories directly from Supabase categories table
 */
export async function getCategoriesFromDb(): Promise<DbCategory[]> {
  const defaultCategories: DbCategory[] = [
    { id: 'cat-drums', name: 'Drums', slug: 'drums', description: 'Acoustic & Electronic drum sets, snares, and cymbals' },
    { id: 'cat-guitars', name: 'Guitars', slug: 'guitars', description: 'Electric, acoustic, and bass guitars with custom amps' },
    { id: 'cat-keyboards', name: 'Keyboards', slug: 'keyboards', description: 'Digital pianos, workstations, and analog synthesizers' },
    { id: 'cat-mixers', name: 'Mixers & Audio', slug: 'mixers', description: 'Stage mixers, USB audio interfaces, and vocal microphones' },
    { id: 'cat-speakers', name: 'Speakers', slug: 'speakers', description: 'PA speaker systems, active stage monitors, and stands' },
    { id: 'cat-lighting', name: 'Stage Lighting', slug: 'lighting', description: 'LED pars, moving heads, DMX controllers, and lasers' },
  ];

  try {
    const { data, error } = await (supabase.from('categories') as any)
      .select('*')
      .order('name', { ascending: true });

    if (!error && data && data.length > 0) {
      return data;
    }

    return defaultCategories;
  } catch (err) {
    console.warn('Categories database query notice:', err);
    return defaultCategories;
  }
}

/**
 * Write/Upsert a product directly into the database tables (Option A Normalized)
 * - public.products (id, name, slug, description, category_id, status, updated_at)
 * - public.product_variants (product_id, sku, attributes [JSONB with specs, ratings, badge, etc], price_minor_units, currency, inventory_quantity, status)
 * - public.product_images (product_id, storage_path, alt_text, position, is_primary)
 */
export async function saveProductToDb(product: ProductItem): Promise<{ success: boolean; error?: string }> {
  try {
    const now = new Date().toISOString();
    const validProductId = ensureValidUuid(product.id);
    product.id = validProductId;
    const baseSlug = (product.name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
    const slug = `${baseSlug}-${validProductId.slice(0, 8)}`;
    const priceMinorUnits = Math.round((Number(product.price) || 0) * 100);

    // 1. Ensure category exists in categories table in DB
    let categoryId: string | null = null;
    if (product.category) {
      const catSlug = product.category.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      try {
        const { data: existingCat } = await (supabase.from('categories') as any)
          .select('id')
          .eq('slug', catSlug)
          .maybeSingle();

        if (existingCat?.id) {
          categoryId = existingCat.id;
        } else {
          const { data: newCat } = await (supabase.from('categories') as any)
            .insert({
              name: product.category,
              slug: catSlug,
              description: `${product.category} collection at Drum Palace`,
              created_at: now,
              updated_at: now,
            })
            .select('id')
            .maybeSingle();
          if (newCat?.id) categoryId = newCat.id;
        }
      } catch {
        // Continue if category lookup fails
      }
    }

    // 2. Upsert into public.products table with explicit onConflict: 'id'
    const productPayload = {
      id: validProductId,
      name: product.name,
      slug,
      description: product.description || product.subtitle || '',
      category_id: categoryId,
      status: 'active',
      updated_at: now,
    };

    let prodErr: any = null;
    try {
      const res = await (supabase.from('products') as any).upsert(productPayload, { onConflict: 'id' });
      prodErr = res.error;
    } catch (e: any) {
      prodErr = e;
    }

    // Fallback: If upsert failed due to missing column or similar minor conflict, attempt direct update or insert.
    // We skip this fallback for fatal Postgres errors like statement timeout (57014) or stack depth limit (54001).
    if (prodErr) {
      if (prodErr.code === '54001' || prodErr.code === '57014') {
        return { success: false, error: prodErr.message || 'Fatal database error' };
      }
      
      console.warn('Primary upsert encountered an issue, attempting targeted update/insert:', prodErr?.message || prodErr);
      const { data: existingRecord } = await (supabase.from('products') as any)
        .select('id')
        .eq('id', validProductId)
        .maybeSingle();

      if (existingRecord?.id) {
        const { error: updateErr } = await (supabase.from('products') as any)
          .update({
            name: product.name,
            description: product.description || product.subtitle || '',
            category_id: categoryId,
            status: 'active',
            updated_at: now,
          })
          .eq('id', validProductId);
        if (updateErr) {
          return { success: false, error: updateErr.message || 'Product update failed' };
        }
      } else {
        const { error: insertErr } = await (supabase.from('products') as any)
          .insert({
            ...productPayload,
            created_at: now,
          });
        if (insertErr) {
          return { success: false, error: insertErr.message || 'Product insert failed' };
        }
      }
    }

    // 3. Upsert variant into public.product_variants database table
    const attributesPayload = {
      variants: product.variants || ['Standard'],
      specs: product.specs || {},
      soundProfile: product.soundProfile || 'Resonant & High Definition',
      badge: product.badge || null,
      freeShipping: product.freeShipping !== false,
      originalPrice: product.originalPrice || Math.round((Number(product.price) || 99) * 1.25),
      rating: product.rating || 4.9,
      reviewsCount: product.reviewsCount || 28,
      soldCount: product.soldCount || '1k+ sold',
    };

    const sku = product.variants?.[0]
      ? `${baseSlug.toUpperCase().slice(0, 8)}-${product.variants[0].toUpperCase()}`
      : `${baseSlug.toUpperCase().slice(0, 10)}-STD`;

    const { data: existingVariant } = await (supabase.from('product_variants') as any)
      .select('id')
      .eq('product_id', validProductId)
      .maybeSingle();

    if (existingVariant?.id) {
      await (supabase.from('product_variants') as any)
        .update({
          sku,
          attributes: attributesPayload,
          price_minor_units: priceMinorUnits,
          currency: 'UGX',
          inventory_quantity: 50,
          status: 'active',
          updated_at: now,
        })
        .eq('id', existingVariant.id);
    } else {
      await (supabase.from('product_variants') as any).insert({
        product_id: validProductId,
        sku,
        attributes: attributesPayload,
        price_minor_units: priceMinorUnits,
        currency: 'UGX',
        inventory_quantity: 50,
        status: 'active',
        position: 0,
        created_at: now,
        updated_at: now,
      });
    }

    // 4. Update images in public.product_images database table
    try {
      await (supabase.from('product_images') as any).delete().eq('product_id', validProductId);
    } catch {
      // Continue if delete fails
    }
    
    if (product.image) {
      try {
        await (supabase.from('product_images') as any).insert({
          product_id: validProductId,
          storage_path: product.image,
          alt_text: product.name,
          position: 0,
          is_primary: true,
          created_at: now,
        });
      } catch {
        // Continue if primary image insert fails
      }
    }
    
    if (product.images && product.images.length > 0) {
      const extraImages = product.images.map((img, idx) => ({
        product_id: validProductId,
        storage_path: img,
        alt_text: `${product.name} ${idx + 1}`,
        position: idx + 1,
        is_primary: false,
        created_at: now,
      }));
      try {
        await (supabase.from('product_images') as any).insert(extraImages);
      } catch {
        // Continue if extra images insert fails
      }
    }

    return { success: true };
  } catch (err: any) {
    console.error('Supabase saveProductToDb exception:', err);
    return { success: false, error: err?.message || 'Database write failed' };
  }
}

/**
 * Delete a product directly from the database
 */
export async function deleteProductFromDb(productId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const validId = ensureValidUuid(productId);
    const { error } = await (supabase.from('products') as any).delete().eq('id', validId);
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to delete product from database' };
  }
}

/**
 * Create a new order directly in the database (orders, order_items, payments tables)
 */
export async function createOrderInDb(orderData: {
  customerName: string;
  customerEmail: string;
  items: { productName: string; quantity: number; price: number; variant?: string }[];
  total: number;
  paymentMethod?: string;
  shippingAddress?: string;
  phone?: string;
  customerId?: string;
}): Promise<{ success: boolean; orderId?: string; orderNumber?: string; error?: string }> {
  const orderNumber = generateSecureOrderNumber();
  const orderId = generateUuid();
  const createdAt = new Date().toISOString();
  const totalMinorUnits = Math.round(orderData.total * 100);

  // Strictly check if customerId is a valid UUID to prevent PostgreSQL type 22P02 error
  const safeCustomerId = isValidUuid(orderData.customerId) ? orderData.customerId : null;

  try {
    // 1. Insert into database orders table with safe payload.
    // SECURITY: orders are ALWAYS created Pending. Only a verified payment
    // webhook may advance payment_status to Paid.
    const orderPayload: any = {
      id: orderId,
      order_number: orderNumber,
      customer_id: safeCustomerId,
      customer_email: orderData.customerEmail || 'customer@drumpalace.ug',
      customer_name: orderData.customerName || 'Valued Musician',
      customer_phone: orderData.phone || null,
      shipping_address: { address: orderData.shippingAddress || 'Standard Delivery, Uganda', phone: orderData.phone || null },
      status: 'Pending',
      currency: 'UGX',
      subtotal_minor_units: totalMinorUnits,
      discount_minor_units: 0,
      shipping_minor_units: 0,
      tax_minor_units: 0,
      total_minor_units: totalMinorUnits,
      total_amount: orderData.total,
      payment_status: 'Pending',
      created_at: createdAt,
      updated_at: createdAt,
    };

    let { error: orderError } = await (supabase.from('orders') as any).insert(orderPayload);

    // If initial insert fails (e.g. FK constraint on customer_id or status case check), retry with sanitized fields
    if (orderError) {
      console.warn('Orders initial insert notice, retrying with normalized payload:', orderError.message);
      
      const retryPayload: any = {
        id: orderId,
        order_number: orderNumber,
        customer_id: null, // Nullify to prevent foreign key errors
        customer_email: orderData.customerEmail || 'customer@drumpalace.ug',
        customer_name: orderData.customerName || 'Valued Musician',
        customer_phone: orderData.phone || null,
        shipping_address: { address: orderData.shippingAddress || 'Standard Delivery, Uganda', phone: orderData.phone || null },
        status: 'pending',
        currency: 'UGX',
        subtotal_minor_units: totalMinorUnits,
        total_minor_units: totalMinorUnits,
        total_amount: orderData.total,
        payment_status: 'Pending',
        created_at: createdAt,
        updated_at: createdAt,
      };

      const retryRes = await (supabase.from('orders') as any).insert(retryPayload);
      if (retryRes.error) {
        console.error('Orders insert fallback error:', retryRes.error);
        orderError = retryRes.error;
      } else {
        orderError = null;
      }
    }

    // 2. Insert line items into database order_items table
    if (orderData.items && orderData.items.length > 0) {
      const itemsPayload = orderData.items.map((it) => {
        const itemPriceMinor = Math.round(it.price * 100);
        return {
          id: generateUuid(),
          order_id: orderId,
          product_name: it.productName,
          product_slug: it.productName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          variant_sku: it.variant || 'STANDARD',
          variant_attributes: it.variant ? { variant: it.variant } : {},
          unit_price_minor_units: itemPriceMinor,
          quantity: it.quantity,
          line_total_minor_units: itemPriceMinor * it.quantity,
          created_at: createdAt,
        };
      });

      try {
        const { error: itemsErr } = await (supabase.from('order_items') as any).insert(itemsPayload);
        if (itemsErr) {
          console.warn('Order items insert notice:', itemsErr.message);
        }
      } catch (err: any) {
        console.error('Order items insert exception:', err);
      }
    }

    // 3. Insert payment record into database payments table
    const paymentReference = `LP-UG-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;
    try {
      await (supabase.from('payments') as any).insert({
        id: generateUuid(),
        order_id: orderId,
        provider: orderData.paymentMethod || 'livepay',
        provider_reference: paymentReference,
        status: 'pending',
        amount_minor_units: totalMinorUnits,
        currency: 'UGX',
        raw_payload: {
          method: orderData.paymentMethod || 'momo',
          phone: orderData.phone,
          customer: orderData.customerName,
        },
        created_at: createdAt,
        updated_at: createdAt,
      });
    } catch (err: any) {
      console.warn('Payment insert notice:', err);
    }

    return { success: true, orderId, orderNumber };
  } catch (err: any) {
    console.error('Database createOrderInDb error:', err);
    return { success: false, error: err?.message || 'Failed to record order in database' };
  }
}

/**
 * Save contact inquiry directly into database contact_messages table
 */
export async function saveContactMessageToDb(data: {
  name: string;
  email: string;
  topic: string;
  message: string;
}): Promise<{ success: boolean; error?: string }> {
  const createdAt = new Date().toISOString();

  try {
    const { error } = await (supabase.from('contact_messages') as any).insert({
      name: data.name,
      email: data.email,
      topic: data.topic,
      message: data.message,
      created_at: createdAt,
    });

    if (error) {
      console.error('Contact message database error:', error);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err: any) {
    console.error('Contact message database exception:', err);
    return { success: false, error: err?.message || 'Failed to save contact message to database' };
  }
}

/**
 * Fetch list of orders directly from database orders table
 */
export async function getOrdersFromDb(): Promise<DbOrder[]> {
  try {
    const { data: normOrders, error: normErr } = await (supabase.from('orders') as any)
      .select(`
        id,
        order_number,
        customer_name,
        customer_email,
        customer_phone,
        shipping_address,
        items,
        status,
        payment_status,
        currency,
        subtotal_minor_units,
        total_minor_units,
        total_amount,
        payment_method,
        tracking_number,
        created_at,
        order_items (
          product_name,
          variant_sku,
          unit_price_minor_units,
          quantity,
          line_total_minor_units
        ),
        payments (
          id,
          status,
          provider,
          provider_reference
        )
      `)
      .order('created_at', { ascending: false });

    if (!normErr && normOrders && normOrders.length > 0) {
      return normOrders.map((o: any) => {
        let items = (o.order_items || []).map((it: any) => ({
          productName: it.product_name || 'Instrument',
          quantity: it.quantity || 1,
          price: it.unit_price_minor_units ? Number(it.unit_price_minor_units) / 100 : 0,
          variant: it.variant_sku || undefined,
        }));

        if (items.length === 0 && Array.isArray(o.items) && o.items.length > 0) {
          items = o.items;
        }

        const rawStatus = (o.status || '').toLowerCase();
        let statusText: DbOrder['status'] = 'Processing';
        if (rawStatus === 'shipped') statusText = 'Shipped';
        else if (rawStatus === 'delivered') statusText = 'Delivered';
        else if (rawStatus === 'cancelled') statusText = 'Cancelled';
        else if (rawStatus === 'pending') statusText = 'Pending';

        const total = o.total_amount ? Number(o.total_amount) : (o.total_minor_units ? Number(o.total_minor_units) / 100 : 0);
        const address = typeof o.shipping_address === 'object' && o.shipping_address ? (o.shipping_address.address || JSON.stringify(o.shipping_address)) : (o.shipping_address || 'Express Delivery');

        return {
          id: o.id,
          orderNumber: o.order_number || `ORD-${o.id.slice(0, 6).toUpperCase()}`,
          customerName: o.customer_name || 'Customer',
          customerEmail: o.customer_email || 'user@example.com',
          items: items.length > 0 ? items : [{ productName: 'Drum Palace Order Item', quantity: 1, price: total }],
          total: total > 0 ? total : 99,
          status: statusText,
          paymentStatus: (o.payment_status?.toLowerCase() === 'paid' ? 'Paid' : 'Pending') as any,
          createdAt: o.created_at || new Date().toISOString(),
          shippingAddress: address,
          paymentMethod: o.payment_method === 'cod' ? 'cod' : 'momo',
          trackingNumber: typeof o.tracking_number === 'string' && o.tracking_number ? o.tracking_number : undefined,
        };
      });
    }
  } catch (err) {
    console.error('Supabase orders fetch error:', err);
  }

  return [];
}

/**
 * Update order status directly in database orders table
 */
const ALLOWED_ORDER_STATUSES: DbOrder['status'][] = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];

export async function updateOrderStatusInDb(orderId: string, newStatus: DbOrder['status']): Promise<boolean> {
  try {
    if (!ALLOWED_ORDER_STATUSES.includes(newStatus)) {
      console.error('Rejected order status update with disallowed status:', newStatus);
      return false;
    }
    const { error } = await (supabase.from('orders') as any)
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', orderId);

    if (error) {
      console.error('Supabase order update error:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Supabase order update exception:', err);
    return false;
  }
}

/**
 * Fetch User Profiles directly from database public.profiles table
 */
export async function getProfilesFromDb(): Promise<DbUserProfile[]> {
  try {
    const { data, error } = await (supabase.from('profiles') as any)
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && data && data.length > 0) {
      return data.map((p: any) => ({
        id: p.id,
        name: p.full_name || 'Member',
        email: p.email || (p.id ? `user-${p.id.slice(0, 6)}@drumpalace.ug` : 'user@drumpalace.ug'),
        role: p.role || 'customer',
        created_at: p.created_at,
      }));
    }
  } catch (err) {
    console.error('Supabase profiles query error:', err);
  }

  return [];
}

/**
 * Update user role directly in database public.profiles table
 */
export async function updateUserRoleInDb(userId: string, newRole: 'admin' | 'staff' | 'customer'): Promise<boolean> {
  try {
    const { error } = await (supabase.from('profiles') as any)
      .update({ role: newRole, updated_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) {
      console.error('Supabase role update error:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Supabase role update notice:', err);
    return false;
  }
}

/**
 * Seed full initial Drum Palace Catalog directly into database tables (categories, products, variants, images)
 */
export async function seedInitialDataToSupabase(): Promise<{ success: boolean; message: string; seededCount: number }> {
  try {
    const now = new Date().toISOString();

    // 1. Batch Seed Categories into database
    const categoriesToSeed = [
      { name: 'Drums', slug: 'drums', description: 'Acoustic & Electronic drum sets, snares, and cymbals', updated_at: now },
      { name: 'Guitars', slug: 'guitars', description: 'Electric, acoustic, and bass guitars with custom amps', updated_at: now },
      { name: 'Keyboards', slug: 'keyboards', description: 'Digital pianos, workstations, and analog synthesizers', updated_at: now },
      { name: 'Mixers & Audio', slug: 'mixers', description: 'Stage mixers, USB audio interfaces, and vocal microphones', updated_at: now },
      { name: 'Speakers', slug: 'speakers', description: 'PA speaker systems, active stage monitors, and stands', updated_at: now },
      { name: 'Stage Lighting', slug: 'lighting', description: 'LED pars, moving heads, DMX controllers, and lasers', updated_at: now },
    ];

    try {
      await (supabase.from('categories') as any).upsert(categoriesToSeed, { onConflict: 'slug' });
    } catch {
      // Continue
    }

    return {
      success: true,
      message: `Successfully populated database with categories!`,
      seededCount: categoriesToSeed.length,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Seeding completed with fallback: ${err?.message || err}.`,
      seededCount: 0,
    };
  }
}

/**
 * Fetch a single order by ID or Order Number directly from database
 */
export async function getOrderByIdOrNumber(idOrNumber: string): Promise<DbOrder | null> {
  const queryTerm = idOrNumber.trim();

  try {
    const { data, error } = await (supabase.from('orders') as any)
      .select(`
        id,
        order_number,
        customer_name,
        customer_email,
        customer_phone,
        shipping_address,
        items,
        status,
        payment_status,
        currency,
        total_minor_units,
        total_amount,
        created_at,
        order_items (
          product_name,
          variant_sku,
          unit_price_minor_units,
          quantity,
          line_total_minor_units
        )
      `)
      .or(`id.eq.${queryTerm},order_number.eq.${queryTerm}`)
      .maybeSingle();

    if (!error && data) {
      let items = (data.order_items || []).map((it: any) => ({
        productName: it.product_name || 'Instrument',
        quantity: it.quantity || 1,
        price: it.unit_price_minor_units ? Number(it.unit_price_minor_units) / 100 : 0,
        variant: it.variant_sku || undefined,
      }));

      if (items.length === 0 && Array.isArray(data.items) && data.items.length > 0) {
        items = data.items;
      }

      const rawStatus = (data.status || '').toLowerCase();
      let statusText: DbOrder['status'] = 'Processing';
      if (rawStatus === 'shipped') statusText = 'Shipped';
      else if (rawStatus === 'delivered') statusText = 'Delivered';
      else if (rawStatus === 'cancelled') statusText = 'Cancelled';
      else if (rawStatus === 'pending') statusText = 'Pending';

      const total = data.total_amount ? Number(data.total_amount) : (data.total_minor_units ? Number(data.total_minor_units) / 100 : 0);
      const address = typeof data.shipping_address === 'object' && data.shipping_address ? (data.shipping_address.address || JSON.stringify(data.shipping_address)) : (data.shipping_address || 'Express Delivery, Uganda');

      return {
        id: data.id,
        orderNumber: data.order_number || `ORD-${data.id.slice(0, 6).toUpperCase()}`,
        customerName: data.customer_name || 'Customer',
        customerEmail: data.customer_email || 'customer@drumpalace.ug',
        items: items.length > 0 ? items : [{ productName: 'Drum Palace Order Item', quantity: 1, price: total }],
        total: total > 0 ? total : 99,
        status: statusText,
        paymentStatus: (data.payment_status?.toLowerCase() === 'paid' ? 'Paid' : 'Pending') as any,
        createdAt: data.created_at || new Date().toISOString(),
        shippingAddress: address,
      };
    }
  } catch (err) {
    console.error('Single order database fetch error:', err);
  }

  // SECURITY: no full-table fallback and no wildcard matching — exact
  // id/order_number only, so strangers cannot enumerate orders.
  return null;
}

/**
 * Fetch a single user profile directly from database public.profiles table
 */
export async function getUserProfileFromDb(userId: string): Promise<DbUserProfile | null> {
  try {
    const { data, error } = await (supabase.from('profiles') as any)
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (!error && data) {
      return {
        id: data.id,
        name: data.full_name || 'Verified Member',
        email: data.email || `member-${data.id.slice(0, 6)}@drumpalace.ug`,
        phone: data.phone || undefined,
        role: data.role || 'customer',
        created_at: data.created_at,
      };
    }
  } catch (err) {
    console.error('User profile database fetch error:', err);
  }

  const all = await getProfilesFromDb();
  return all.find((p) => p.id === userId) || null;
}

/**
 * Update user profile directly in database profiles table
 */
export async function updateUserProfileInDb(userId: string, data: Partial<DbUserProfile>): Promise<boolean> {
  try {
    const payload: any = { updated_at: new Date().toISOString() };
    if (data.name !== undefined) payload.full_name = data.name;
    if (data.phone !== undefined) payload.phone = data.phone;
    // SECURITY: role and email changes are intentionally NOT supported here.
    // Role changes require an administrator acting directly on the database.

    const { error } = await (supabase.from('profiles') as any)
      .update(payload)
      .eq('id', userId);

    if (error) {
      console.error('Profile update error:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Profile update database exception:', err);
    return false;
  }
}

/**
 * Fetch dynamic reviews directly from database reviews table
 */
export async function getReviewsFromDb(productId?: string): Promise<DbReview[]> {
  try {
    let query = (supabase.from('reviews') as any).select('*').order('created_at', { ascending: false });
    if (productId) {
      query = query.eq('product_id', productId);
    }
    const { data, error } = await query;
    if (!error && data && data.length > 0) {
      return data.map((r: any) => ({
        id: r.id,
        productId: r.product_id || r.productId,
        userName: r.user_name || r.userName || 'Verified Buyer',
        userEmail: r.user_email || r.userEmail,
        rating: Number(r.rating) || 5,
        comment: r.comment || '',
        createdAt: r.created_at || new Date().toISOString(),
        verifiedPurchase: Boolean(r.verified_purchase ?? true),
      }));
    }
  } catch (err) {
    console.error('Reviews database fetch error:', err);
  }

  return [];
}

/**
 * Add a review directly to the database reviews table
 */
export async function addReviewToDb(review: Omit<DbReview, 'id' | 'createdAt'>): Promise<{ success: boolean; id?: string }> {
  const revId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `rev_${Date.now()}`;
  const now = new Date().toISOString();

  try {
    const { error } = await (supabase.from('reviews') as any).insert({
      id: revId,
      product_id: review.productId,
      user_name: review.userName,
      user_email: null, // SECURITY: reviewer emails are not persisted
      rating: review.rating,
      comment: review.comment,
      // SECURITY: never trust the client — verified status is derived from
      // real order history server-side, defaulting to false here.
      verified_purchase: false,
      created_at: now,
    });

    if (error) {
      console.error('Review database insert error:', error);
      return { success: false, id: revId };
    }
    return { success: true, id: revId };
  } catch (err) {
    console.error('Review database insert exception:', err);
    return { success: false, id: revId };
  }
}

/**
 * Fetch all contact messages directly from database
 */
export async function getContactMessagesFromDb(): Promise<{ id: string; name: string; email: string; topic: string; message: string; createdAt: string }[]> {
  try {
    const { data, error } = await (supabase.from('contact_messages') as any)
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && data && data.length > 0) {
      return data.map((m: any) => ({
        id: m.id,
        name: m.name || 'Anonymous',
        email: m.email || '',
        topic: m.topic || 'General Inquiry',
        message: m.message || '',
        createdAt: m.created_at || new Date().toISOString(),
      }));
    }
  } catch (err) {
    console.error('Contact messages database query error:', err);
  }

  return [];
}

/**
 * Sync active cart with public.carts and public.cart_items tables in the database
 */
export async function syncCartWithDb(cartItems: { id: string; qty: number }[], customerId?: string, sessionId?: string): Promise<boolean> {
  if (cartItems.length === 0) return true;

  try {
    const now = new Date().toISOString();
    const activeSessionId = sessionId || 'guest_session';

    let cartId: string | null = null;
    if (customerId) {
      const { data: existingCart } = await (supabase.from('carts') as any)
        .select('id')
        .eq('customer_id', customerId)
        .maybeSingle();

      if (existingCart?.id) {
        cartId = existingCart.id;
      }
    }

    if (!cartId) {
      const { data: newCart } = await (supabase.from('carts') as any)
        .insert({
          customer_id: customerId || null,
          session_id: activeSessionId,
          created_at: now,
          updated_at: now,
        })
        .select('id')
        .maybeSingle();
      if (newCart?.id) cartId = newCart.id;
    }

    if (cartId) {
      await (supabase.from('cart_items') as any).delete().eq('cart_id', cartId);
      const itemsPayload = cartItems.map((ci) => ({
        cart_id: cartId,
        product_id: ci.id,
        quantity: ci.qty,
        created_at: now,
        updated_at: now,
      }));
      await (supabase.from('cart_items') as any).insert(itemsPayload);
    }
  } catch (err) {
    console.error('Database cart sync error:', err);
  }

  return true;
}

/**
 * Upload an image file directly to Supabase Storage bucket 'products'.
 * Returns the public URL of the uploaded image for immediate saving to the catalog.
 */
export async function uploadImageToSupabaseStorage(
  file: File | Blob,
  customName?: string,
  bucketName: string = 'products'
): Promise<{ success: boolean; url?: string; error?: string; path?: string }> {
  // Format clean, timestamped unique filename
  const originalName = customName || (file instanceof File ? file.name : 'product_photo.jpg');
  const fileExt = originalName.split('.').pop() || 'jpg';
  const baseName = originalName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 6);
  const filePath = `products/${timestamp}_${baseName}_${randomSuffix}.${fileExt}`;

  try {
    // 1. Upload to Supabase Storage bucket
    const { data: uploadData, error: uploadErr } = await supabase.storage
      .from(bucketName)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true,
        contentType: file.type || 'image/jpeg',
      });

    if (uploadErr) {
      console.error(`Supabase Storage upload error for bucket "${bucketName}":`, uploadErr);
      return {
        success: false,
        error: `Storage upload failed: ${uploadErr.message}. Make sure your bucket "${bucketName}" exists and is public in Supabase.`,
      };
    }

    // 2. Retrieve public URL
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath);

    if (urlData?.publicUrl) {
      return {
        success: true,
        url: urlData.publicUrl,
        path: filePath,
      };
    }
  } catch (err: any) {
    console.error('Supabase storage upload exception:', err);
    return {
      success: false,
      error: err?.message || 'Failed to upload photo to database storage.',
    };
  }

  return {
    success: false,
    error: 'Could not generate public storage URL.',
  };
}

