"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import Image from "next/image";
import {
  LayoutDashboard,
  Package,
  ShoppingBag,
  Sliders,
  Users,
  Database,
  Search,
  Plus,
  Edit,
  Trash2,
  Check,
  X,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  TrendingUp,
  DollarSign,
  Truck,
  ArrowLeft,
  Lock,
  Eye,
  EyeOff,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Clock,
  Layers,
  Phone,
  Mail,
  MapPin,
  Save,
  Copy,
  FileText,
  Filter,
  ArrowUpRight,
  ShieldCheck,
  Upload,
  Image as ImageIcon,
  ArrowUp,
  ArrowDown,
  Flame,
  Percent,
  Tag,
  Menu,
  CreditCard,
  Globe,
  Activity,
  Key,
  Terminal,
  Send
} from "lucide-react";
import { ProductItem } from "@/lib/types";
import { 
  DbOrder, 
  DbUserProfile, 
  getProductsFromDb, 
  saveProductToDb, 
  deleteProductFromDb, 
  getOrdersFromDb, 
  updateOrderStatusInDb, 
  getProfilesFromDb, 
  updateUserRoleInDb,
  seedInitialDataToSupabase,
  uploadImageToSupabaseStorage,
  generateUuid,
  ensureValidUuid
} from "@/lib/supabaseDb";
import { signInWithEmail, fetchUserProfile, signOutUser } from "@/lib/supabaseAuth";
import { 
  getActiveSupabaseConfig, 
  saveSupabaseConfig, 
  clearSupabaseConfig, 
  testSupabaseConnection, 
  ConnectionDiagnosticResult,
  DRUM_PALACE_COMPLETE_SCHEMA_SQL,
  supabase
} from "@/lib/supabase";
import { formatMoney } from "@/lib/utils";
import { getStoreSettings, saveStoreSettings, StoreSettings, DEFAULT_STORE_SETTINGS, BannerSlide, DEFAULT_BANNER_SLIDES, HotDealItem, DEFAULT_HOT_DEALS } from "@/lib/storeSettings";

interface AdminPortalProps {
  currentUser: { id?: string; name?: string; email: string; role?: string } | null;
  onClose: () => void;
  onProductsUpdated?: (products: ProductItem[]) => void;
  onAdminAuthenticated?: (admin: { id?: string; name?: string; email: string; role: string }) => void;
  currency: string;
}

export default function AdminPortal({
  currentUser,
  onClose,
  onProductsUpdated,
  onAdminAuthenticated,
  currency = "UGX",
}: AdminPortalProps) {
  // Authentication State - Computed from activeAdmin or currentUser.role === 'admin'
  const [activeAdmin, setActiveAdmin] = useState<{ id?: string; name?: string; email: string; role: string } | null>(null);

  const effectiveAdmin = useMemo(() => {
    if (activeAdmin) return activeAdmin;
    if (currentUser && currentUser.role === 'admin') {
      return {
        id: currentUser.id,
        name: currentUser.name || 'Store Administrator',
        email: currentUser.email,
        role: 'admin',
      };
    }
    return null;
  }, [activeAdmin, currentUser]);

  const [adminEmail, setAdminEmail] = useState(currentUser?.email || "");
  const [adminPassword, setAdminPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Navigation & Data States
  const [currentTab, setCurrentTab] = useState<"overview" | "products" | "hot_deals" | "site_editor" | "orders" | "customers" | "cloud_sync" | "livepay">("overview");
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [orders, setOrders] = useState<DbOrder[]>([]);
  const [profiles, setProfiles] = useState<DbUserProfile[]>([]);
  const [storeSettings, setStoreSettings] = useState<StoreSettings>(getStoreSettings);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [orderStatusFilter, setOrderStatusFilter] = useState("All");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);

  // LivePay Payment Gateway States (https://docs.livepay.me/)
  // SECURITY: gateway credentials are server-side environment variables ONLY.
  // They are no longer typed into the browser or stored in localStorage.
  const [livepayApiKey, setLivepayApiKey] = useState<string>("");
  const [livepaySecretKey, setLivepaySecretKey] = useState<string>("");
  const [livepayMerchantId, setLivepayMerchantId] = useState<string>("");
  const [livepayApiUrl, setLivepayApiUrl] = useState<string>("");
  const [livepayWebhookSecret, setLivepayWebhookSecret] = useState<string>("");
  const [isTestingLivepay, setIsTestingLivepay] = useState<boolean>(false);
  const [livepayTestResult, setLivepayTestResult] = useState<any>(null);
  const [copiedWebhook, setCopiedWebhook] = useState<boolean>(false);

  // Hot Deals Manager States
  const [selectedProductForDeal, setSelectedProductForDeal] = useState<string>("");
  const [newDealDiscount, setNewDealDiscount] = useState<number>(25);
  const [newDealBadge, setNewDealBadge] = useState<string>("Flash Deal");
  const [newDealCustomTitle, setNewDealCustomTitle] = useState<string>("");
  const [newDealCustomImage, setNewDealCustomImage] = useState<string>("");
  const [dealSearchQuery, setDealSearchQuery] = useState<string>("");

  // Banner Slide Manager States
  const [newSlideForm, setNewSlideForm] = useState<Partial<BannerSlide>>({
    caption: "",
    subtext: "",
    ctaText: "Shop Sale",
    image: "",
    categoryFilter: "all",
  });
  const [isAddingNewSlide, setIsAddingNewSlide] = useState(false);

  // Product Editor Modal State
  const [editingProduct, setEditingProduct] = useState<ProductItem | null>(null);
  const [isNewProduct, setIsNewProduct] = useState(false);
  const [productForm, setProductForm] = useState<Partial<ProductItem>>({});
  const [specList, setSpecList] = useState<{ key: string; val: string }[]>([]);
  const [variantsString, setVariantsString] = useState("");
  const [isUploadingProductImage, setIsUploadingProductImage] = useState(false);
  const [productImageUploadStatus, setProductImageUploadStatus] = useState<string | null>(null);
  const [isManualUrlMode, setIsManualUrlMode] = useState(false);

  // Cloud Sync / Data Engine states
  const [cloudConfig, setCloudConfig] = useState(() => getActiveSupabaseConfig());
  const [inputCloudUrl, setInputCloudUrl] = useState(() => getActiveSupabaseConfig().source !== 'none' ? getActiveSupabaseConfig().url : '');
  const [inputCloudKey, setInputCloudKey] = useState(() => getActiveSupabaseConfig().source !== 'none' ? getActiveSupabaseConfig().anonKey : '');
  const [isTestingCloud, setIsTestingCloud] = useState(false);
  const [isSeedingData, setIsSeedingData] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<ConnectionDiagnosticResult | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [prods, ords, profs] = await Promise.all([
        getProductsFromDb(),
        getOrdersFromDb(),
        getProfilesFromDb(),
      ]);
      setProducts(prods);
      setOrders(ords);
      setProfiles(profs);
      setStoreSettings(getStoreSettings());
      if (onProductsUpdated) {
        onProductsUpdated(prods);
      }
    } catch (err) {
      console.error("Failed to load store data:", err);
    } finally {
      setLoading(false);
    }
  }, [onProductsUpdated]);

  useEffect(() => {
    let isSubscribed = true;
    if (effectiveAdmin && effectiveAdmin.role === "admin") {
      Promise.all([
        getProductsFromDb(),
        getOrdersFromDb(),
        getProfilesFromDb(),
      ]).then(([prods, ords, profs]) => {
        if (isSubscribed) {
          setProducts(prods);
          setOrders(ords);
          setProfiles(profs);
          setStoreSettings(getStoreSettings());
          setLoading(false);
          if (onProductsUpdated) {
            onProductsUpdated(prods);
          }
        }
      }).catch((err) => {
        console.error("Failed to load store data:", err);
        if (isSubscribed) setLoading(false);
      });
    }
    return () => {
      isSubscribed = false;
    };
  }, [effectiveAdmin, onProductsUpdated]);

  // Handle Admin Sign In
  const handleAdminSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminEmail.trim() || !adminPassword) {
      setAuthError("Please enter both administrator email and password.");
      return;
    }

    setIsAuthenticating(true);
    setAuthError(null);

    try {
      // 1. Attempt Supabase Auth login
      const { user, error } = await signInWithEmail(adminEmail.trim(), adminPassword);

      if (!error && user) {
        // Strictly verify user role from the database public.profiles record
        const profile = await fetchUserProfile(user.id);
        const userRole = profile?.role || "customer";

        if (userRole !== "admin") {
          // Strictly reject non-admin users and invalidate the session.
          // Deliberately generic: "this account exists but is not an admin"
          // confirms to a prober that the credentials they just tried are valid.
          await signOutUser();
          console.warn("Admin sign-in rejected: authenticated account lacks the admin role.", { userId: user.id });
          setAuthError("Authentication failed: Invalid administrator credentials or unauthorized user account.");
          setIsAuthenticating(false);
          return;
        }

        const adminObj = {
          id: user.id,
          name: profile?.name || user.user_metadata?.full_name || "Store Administrator",
          email: user.email || adminEmail.trim(),
          role: "admin",
        };

        setActiveAdmin(adminObj);
        if (onAdminAuthenticated) {
          onAdminAuthenticated(adminObj);
        }
        showToast("Authenticated as Store Administrator");
        return;
      }

      // SECURITY: the previous "offline fallback" accepted any profile whose role
      // was admin as long as the typed password was 4+ characters — a backdoor.
      // Removed. Admin access now requires a valid Supabase Auth session whose
      // database profile role is 'admin' (checked above and re-checked server-side
      // by every privileged API route).
      setAuthError("Authentication failed: Invalid administrator credentials or unauthorized user account.");
    } catch (err: any) {
      setAuthError(err?.message || "An unexpected error occurred during administrator authentication.");
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleAdminSignOut = async () => {
    await signOutUser();
    setActiveAdmin(null);
    onClose();
  };

  // Product Management Handlers
  const handleOpenNewProduct = () => {
    setIsNewProduct(true);
    setProductForm({
      id: generateUuid(),
      name: "",
      category: "Drums",
      subtitle: "",
      price: 1500000,
      originalPrice: 1850000,
      rating: 5.0,
      reviewsCount: 12,
      soldCount: "100+ sold",
      image: "https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=800&q=85",
      badge: "New Arrival",
      description: "Professional grade instrument crafted for stage, studio, and acoustic performance.",
      soundProfile: "Warm, resonant tone with clean harmonic sustain",
      freeShipping: true,
    });
    setSpecList([
      { key: "Craftsmanship", val: "Handcrafted" },
      { key: "Origin", val: "Drum Palace Uganda" },
      { key: "Warranty", val: "1-Year Official Warranty" },
    ]);
    setVariantsString("Standard, Custom Finish");
    setProductImageUploadStatus(null);
    setIsManualUrlMode(false);
    setEditingProduct({ id: "new" } as any);
  };

  const handleOpenEditProduct = (prod: ProductItem) => {
    setIsNewProduct(false);
    setProductForm({ ...prod });
    const specsArray = Object.entries(prod.specs || {}).map(([key, val]) => ({
      key,
      val: String(val),
    }));
    setSpecList(specsArray.length > 0 ? specsArray : [{ key: "Type", val: "Pro Gear" }]);
    setVariantsString((prod.variants || []).join(", "));
    setProductImageUploadStatus(null);
    setIsManualUrlMode(false);
    setEditingProduct(prod);
  };

  const handleProductImageFileUpload = async (file: File) => {
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      alert("Please choose a valid photo file (PNG, JPG, WEBP, GIF, SVG).");
      return;
    }

    if (file.size > 15 * 1024 * 1024) {
      alert("Selected photo is larger than 15MB. Please choose a smaller image.");
      return;
    }

    setIsUploadingProductImage(true);
    setProductImageUploadStatus("Uploading directly to Supabase Storage bucket 'products'...");

    try {
      const res = await uploadImageToSupabaseStorage(file, file.name, "products");

      if (res.success && res.url) {
        setProductForm((prev) => ({ ...prev, image: res.url }));
        setProductImageUploadStatus("Photo uploaded to Supabase bucket 'products'!");
        showToast("Photo uploaded to Supabase Storage");
      } else {
        setProductImageUploadStatus(`Upload notice: ${res.error || "Failed to upload"}`);
        alert(res.error || "Failed to upload photo to Supabase Storage.");
      }
    } catch (err: any) {
      console.error("Photo upload error:", err);
      setProductImageUploadStatus("Upload failed. Please try again.");
      alert(`Error uploading image: ${err?.message || err}`);
    } finally {
      setIsUploadingProductImage(false);
    }
  };

  const handleAdditionalImageFileUpload = async (file: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("Please choose a valid photo file.");
      return;
    }
    setIsUploadingProductImage(true);
    setProductImageUploadStatus("Uploading additional image to Supabase Storage...");
    try {
      const res = await uploadImageToSupabaseStorage(file, file.name, "products");
      if (res.success && res.url) {
        setProductForm((prev) => ({ 
          ...prev, 
          images: [...(prev.images || []), res.url as string] 
        }));
        showToast("Additional photo uploaded");
      } else {
        alert("Failed to upload: " + (res.error || "Unknown error"));
      }
    } catch (e: any) {
      alert("Upload failed: " + e.message);
    } finally {
      setIsUploadingProductImage(false);
      setProductImageUploadStatus(null);
    }
  };

  const handleSaveProductForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productForm.name || !productForm.price) {
      alert("Product name and price are required.");
      return;
    }

    const specsObj: Record<string, string> = {};
    specList.forEach((s) => {
      if (s.key.trim()) {
        specsObj[s.key.trim()] = s.val.trim();
      }
    });

    const parsedVariants = variantsString
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    const productId = ensureValidUuid(productForm.id);

    const fullProduct: ProductItem = {
      id: productId,
      name: productForm.name.trim(),
      category: productForm.category || "Drums",
      subtitle: productForm.subtitle || "",
      price: Number(productForm.price) || 99,
      originalPrice: Number(productForm.originalPrice) || Number(productForm.price) * 1.2,
      rating: Number(productForm.rating) || 4.9,
      reviewsCount: Number(productForm.reviewsCount) || 15,
      soldCount: productForm.soldCount || "50+ sold",
      image: productForm.image || "https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=800&q=85",
      images: productForm.images || [],
      badge: productForm.badge || undefined,
      description: productForm.description || "",
      specs: specsObj,
      soundProfile: productForm.soundProfile || "Balanced & High Definition",
      variants: parsedVariants.length > 0 ? parsedVariants : ["Standard"],
      freeShipping: Boolean(productForm.freeShipping),
    };

    const saveRes = await saveProductToDb(fullProduct);
    if (!saveRes.success) {
      alert(`Could not save product to database: ${saveRes.error || "Unknown error"}`);
      return;
    }

    showToast(isNewProduct ? `Created "${fullProduct.name}"` : `Updated "${fullProduct.name}"`);
    setEditingProduct(null);
    loadData();
  };

  const handleDeleteProduct = async (prod: ProductItem) => {
    if (confirm(`Are you sure you want to delete "${prod.name}" from catalog?`)) {
      await deleteProductFromDb(prod.id);
      showToast(`Removed "${prod.name}" from catalog`);
      loadData();
    }
  };

  // Order Management Handlers
  const handleUpdateOrderStatus = async (orderId: string, status: DbOrder["status"]) => {
    await updateOrderStatusInDb(orderId, status);
    showToast(`Order status updated to "${status}"`);
    loadData();
  };

  // Manual payment reconciliation escape hatch (admin-only). Used when the gateway
  // webhook could not confirm a payment. Every change is audit-logged server-side.
  const handleUpdatePaymentStatus = async (orderId: string, paymentStatus: "Pending" | "Paid" | "Failed" | "Refunded") => {
    try {
      let accessToken: string | null = null;
      try {
        const { data } = await supabase.auth.getSession();
        accessToken = data?.session?.access_token || null;
      } catch {
        accessToken = null;
      }
      if (!accessToken) {
        showToast("Session expired. Please sign in again to update payment status.");
        return;
      }
      const res = await fetch("/api/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ orderId, paymentStatus }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        showToast(data?.error || "Could not update payment status.");
        return;
      }
      showToast(`Payment marked "${paymentStatus}" for order.`);
      loadData();
    } catch (e: any) {
      showToast("Could not update payment status.");
    }
  };

  // User Management Handlers
  const handleUpdateUserRole = async (userId: string, newRole: "admin" | "staff" | "customer") => {
    await updateUserRoleInDb(userId, newRole);
    showToast(`User role updated to "${newRole}"`);
    loadData();
  };

  // Banner Slide Handlers
  const handleAddBannerSlide = () => {
    if (!newSlideForm.image?.trim()) {
      showToast("Please provide an image for the slide (upload or URL)");
      return;
    }
    const newSlide: BannerSlide = {
      id: `slide_${Date.now()}`,
      caption: newSlideForm.caption?.trim() || "Special Promotion",
      subtext: newSlideForm.subtext?.trim() || "",
      ctaText: newSlideForm.ctaText?.trim() || "Shop Now",
      image: newSlideForm.image.trim(),
      categoryFilter: newSlideForm.categoryFilter || "all",
    };

    const currentSlides = storeSettings.bannerSlides || DEFAULT_BANNER_SLIDES;
    const updated = [...currentSlides, newSlide];
    const newSettings = { ...storeSettings, bannerSlides: updated };
    setStoreSettings(newSettings);
    saveStoreSettings(newSettings);
    setNewSlideForm({
      caption: "",
      subtext: "",
      ctaText: "Shop Sale",
      image: "",
      categoryFilter: "all",
    });
    setIsAddingNewSlide(false);
    showToast("Added new banner slide!");
  };

  const handleDeleteBannerSlide = (slideId: string) => {
    const currentSlides = storeSettings.bannerSlides || DEFAULT_BANNER_SLIDES;
    if (currentSlides.length <= 1) {
      showToast("Must have at least 1 banner slide active");
      return;
    }
    const updated = currentSlides.filter((s) => s.id !== slideId);
    const newSettings = { ...storeSettings, bannerSlides: updated };
    setStoreSettings(newSettings);
    saveStoreSettings(newSettings);
    showToast("Removed banner slide");
  };

  const handleMoveBannerSlide = (index: number, direction: "up" | "down") => {
    const currentSlides = [...(storeSettings.bannerSlides || DEFAULT_BANNER_SLIDES)];
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= currentSlides.length) return;

    const temp = currentSlides[index];
    currentSlides[index] = currentSlides[targetIndex];
    currentSlides[targetIndex] = temp;

    const newSettings = { ...storeSettings, bannerSlides: currentSlides };
    setStoreSettings(newSettings);
    saveStoreSettings(newSettings);
    showToast("Reordered banner slides");
  };

  const handleUpdateSlideField = (index: number, field: keyof BannerSlide, value: string) => {
    const currentSlides = [...(storeSettings.bannerSlides || DEFAULT_BANNER_SLIDES)];
    if (!currentSlides[index]) return;
    currentSlides[index] = { ...currentSlides[index], [field]: value };
    const newSettings = { ...storeSettings, bannerSlides: currentSlides };
    setStoreSettings(newSettings);
    saveStoreSettings(newSettings);
  };

  const handleSlideImageFileUpload = async (file: File, forNewSlide: boolean, slideIndex?: number) => {
    if (!file) return;
    showToast("Uploading slide photo to Supabase Storage...");
    try {
      const res = await uploadImageToSupabaseStorage(file, file.name, "products");
      if (res.success && res.url) {
        if (forNewSlide) {
          setNewSlideForm((prev) => ({ ...prev, image: res.url! }));
        } else if (slideIndex !== undefined) {
          const currentSlides = [...(storeSettings.bannerSlides || DEFAULT_BANNER_SLIDES)];
          if (currentSlides[slideIndex]) {
            currentSlides[slideIndex] = { ...currentSlides[slideIndex], image: res.url! };
            const newSettings = { ...storeSettings, bannerSlides: currentSlides };
            setStoreSettings(newSettings);
            saveStoreSettings(newSettings);
          }
        }
        showToast("Slide photo uploaded to Supabase Storage & saved!");
      } else {
        alert(res.error || "Failed to upload slide image.");
      }
    } catch (err: any) {
      console.error("Slide upload error:", err);
      alert(`Error uploading image: ${err?.message || err}`);
    }
  };

  const handleResetBannerSlides = () => {
    if (confirm("Reset banner slides to default collection?")) {
      const newSettings = { ...storeSettings, bannerSlides: DEFAULT_BANNER_SLIDES };
      setStoreSettings(newSettings);
      saveStoreSettings(newSettings);
      showToast("Reset banner slides to default!");
    }
  };

  // Hot Deals Manager Handlers
  const handleUpdateDealField = (index: number, field: keyof HotDealItem, value: any) => {
    const currentDeals = [...(storeSettings.hotDeals || DEFAULT_HOT_DEALS)];
    if (!currentDeals[index]) return;
    currentDeals[index] = { ...currentDeals[index], [field]: value };
    const updated = { ...storeSettings, hotDeals: currentDeals };
    setStoreSettings(updated);
    saveStoreSettings(updated);
  };

  const handleDealImageFileUpload = async (file: File, dealIndex: number) => {
    if (!file) return;
    showToast("Uploading Hot Deal photo to Supabase Storage...");
    try {
      const res = await uploadImageToSupabaseStorage(file, file.name, "products");
      if (res.success && res.url) {
        const currentDeals = [...(storeSettings.hotDeals || DEFAULT_HOT_DEALS)];
        if (currentDeals[dealIndex]) {
          currentDeals[dealIndex] = { ...currentDeals[dealIndex], customImage: res.url! };
          const updatedSettings = { ...storeSettings, hotDeals: currentDeals };
          setStoreSettings(updatedSettings);
          saveStoreSettings(updatedSettings);
          showToast("Hot Deal photo uploaded & saved!");
        }
      } else {
        alert(res.error || "Failed to upload deal photo.");
      }
    } catch (err: any) {
      console.error("Deal image upload error:", err);
      alert(`Error uploading deal image: ${err?.message || err}`);
    }
  };

  const handleToggleDealActive = (index: number) => {
    const currentDeals = [...(storeSettings.hotDeals || DEFAULT_HOT_DEALS)];
    if (!currentDeals[index]) return;
    currentDeals[index] = { ...currentDeals[index], active: !currentDeals[index].active };
    const updated = { ...storeSettings, hotDeals: currentDeals };
    setStoreSettings(updated);
    saveStoreSettings(updated);
    showToast(currentDeals[index].active ? "Deal enabled on storefront" : "Deal hidden from storefront");
  };

  const handleAddProductToHotDeals = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const currentDeals = [...(storeSettings.hotDeals || DEFAULT_HOT_DEALS)];
    if (currentDeals.length >= 8) {
      alert("Maximum limit of 8 hot deal slides reached. Remove an existing deal to add a new one.");
      return;
    }
    if (!selectedProductForDeal) {
      alert("Please select a product from the inventory.");
      return;
    }
    if (currentDeals.some(d => d.productId === selectedProductForDeal)) {
      alert("This product is already in the Hot Deals list.");
      return;
    }
    const newDeal: HotDealItem = {
      id: `deal-${Date.now()}`,
      productId: selectedProductForDeal,
      customTitle: newDealCustomTitle.trim() || undefined,
      customImage: newDealCustomImage.trim() || undefined,
      discountPercent: Math.max(1, Math.min(90, Number(newDealDiscount) || 25)),
      customBadge: newDealBadge.trim() || "Flash Deal",
      active: true,
    };
    const updatedDeals = [...currentDeals, newDeal];
    const updatedSettings = { ...storeSettings, hotDeals: updatedDeals };
    setStoreSettings(updatedSettings);
    saveStoreSettings(updatedSettings);
    setSelectedProductForDeal("");
    setNewDealCustomTitle("");
    setNewDealCustomImage("");
    showToast("Product added to Hot Deals!");
  };

  const handleRemoveHotDeal = (dealId: string) => {
    const currentDeals = [...(storeSettings.hotDeals || DEFAULT_HOT_DEALS)];
    const filtered = currentDeals.filter(d => d.id !== dealId);
    const updatedSettings = { ...storeSettings, hotDeals: filtered };
    setStoreSettings(updatedSettings);
    saveStoreSettings(updatedSettings);
    showToast("Removed deal from rotation");
  };

  const handleMoveHotDeal = (index: number, direction: "up" | "down") => {
    const currentDeals = [...(storeSettings.hotDeals || DEFAULT_HOT_DEALS)];
    if (direction === "up" && index > 0) {
      const temp = currentDeals[index];
      currentDeals[index] = currentDeals[index - 1];
      currentDeals[index - 1] = temp;
    } else if (direction === "down" && index < currentDeals.length - 1) {
      const temp = currentDeals[index];
      currentDeals[index] = currentDeals[index + 1];
      currentDeals[index + 1] = temp;
    }
    const updatedSettings = { ...storeSettings, hotDeals: currentDeals };
    setStoreSettings(updatedSettings);
    saveStoreSettings(updatedSettings);
  };

  const handleResetHotDeals = () => {
    if (confirm("Reset hot deals to the default 8 promotional items?")) {
      const updatedSettings = { ...storeSettings, hotDeals: DEFAULT_HOT_DEALS };
      setStoreSettings(updatedSettings);
      saveStoreSettings(updatedSettings);
      showToast("Reset hot deals to default selection!");
    }
  };

  // Site Settings Customizer Handlers
  const handleSaveStoreCustomizer = (e: React.FormEvent) => {
    e.preventDefault();
    saveStoreSettings(storeSettings);
    showToast("Storefront content saved successfully!");
  };

  // Cloud Diagnostics & Sync Handlers
  const handleRunDiagnostics = async () => {
    setIsTestingCloud(true);
    try {
      const res = await testSupabaseConnection();
      setDiagnosticResult(res);
    } catch (e) {
      console.error("Diagnostic error:", e);
    } finally {
      setIsTestingCloud(false);
    }
  };

  const handleSaveCloudKeys = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputCloudUrl.trim() || !inputCloudKey.trim()) {
      alert("Please enter both endpoint URL and key.");
      return;
    }
    saveSupabaseConfig(inputCloudUrl.trim(), inputCloudKey.trim());
    setCloudConfig(getActiveSupabaseConfig());
    showToast("Cloud sync credentials saved!");
    handleRunDiagnostics();
  };

  const handleSeedCatalogNow = async () => {
    setIsSeedingData(true);
    try {
      const res = await seedInitialDataToSupabase();
      if (res.success) {
        showToast(res.message);
        loadData();
        handleRunDiagnostics();
      } else {
        alert(res.message);
      }
    } catch (e: any) {
      alert(`Error during catalog sync: ${e?.message || e}`);
    } finally {
      setIsSeedingData(false);
    }
  };

  const handleCopySchemaSql = () => {
    navigator.clipboard.writeText(DRUM_PALACE_COMPLETE_SCHEMA_SQL);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2000);
    showToast("SQL schema copied to clipboard");
  };

  // LivePay Gateway Handlers
  const handleTestLivepayConnection = async () => {
    setIsTestingLivepay(true);
    setLivepayTestResult(null);
    try {
      // Server uses its own env credentials; no secrets are sent from the browser.
      const res = await fetch("/api/payments/livepay/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      setLivepayTestResult(data);
      if (data.success) {
        showToast("LivePay Gateway test completed successfully!");
      } else {
        showToast(data.message || "LivePay test response received");
      }
    } catch (e: any) {
      setLivepayTestResult({
        success: false,
        error: e.message || "Network test failed",
      });
    } finally {
      setIsTestingLivepay(false);
    }
  };

  const handleCopyWebhookUrl = () => {
    const origin = typeof window !== "undefined" ? window.location.origin : "https://drumpalace.ug";
    const webhookUrl = `${origin}/api/payments/livepay/webhook`;
    navigator.clipboard.writeText(webhookUrl);
    setCopiedWebhook(true);
    setTimeout(() => setCopiedWebhook(false), 2000);
    showToast("LivePay Webhook URL copied to clipboard!");
  };

  // Filters & Calculations
  const filteredProducts = products.filter((p) => {
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCat = categoryFilter === "All" || p.category === categoryFilter;
    return matchesSearch && matchesCat;
  });

  const categories = ["All", ...Array.from(new Set(products.map((p) => p.category)))];

  const filteredOrders = orders.filter((o) => {
    if (orderStatusFilter === "All") return true;
    return o.status === orderStatusFilter;
  });

  const totalRevenue = orders.reduce((sum, o) => sum + (o.paymentStatus === "Paid" ? o.total : 0), 0);

  // -------------------------------------------------------------
  // VIEW: Admin Authentication Screen
  // -------------------------------------------------------------
  if (!effectiveAdmin) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-2xl relative overflow-hidden dark:bg-slate-900 dark:border-slate-800">
          <button
            onClick={onClose}
            className="absolute top-5 right-5 rounded-lg p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <X size={18} />
          </button>

          <div className="mb-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs font-semibold mb-3">
              <Lock size={12} />
              <span>Restricted Staff Access · Admin Authentication Required</span>
            </div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Drum Palace Control Center</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              You must authenticate with a verified Store Administrator account to access store controls, inventory, orders, and site settings.
            </p>
          </div>

          {authError && (
            <div className="mb-5 rounded-xl bg-rose-50 border border-rose-200 p-3.5 text-xs text-rose-700 dark:bg-rose-950/30 dark:border-rose-800 dark:text-rose-400 flex items-start gap-2.5">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{authError}</span>
            </div>
          )}

          <form onSubmit={handleAdminSignIn} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Administrator Email
              </label>
              <input
                type="email"
                required
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="admin@drumpalace.ug"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm font-medium text-slate-900 focus:bg-white focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white transition"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Administrator Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 pr-10 text-sm font-medium text-slate-900 focus:bg-white focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-2">
              <ShieldCheck size={14} className="text-teal-600 dark:text-teal-400 shrink-0" />
              <span>Zero-trust role verification active. Customer accounts cannot access administrative panels.</span>
            </div>

            <button
              type="submit"
              disabled={isAuthenticating}
              className="w-full rounded-xl bg-teal-600 hover:bg-teal-700 text-white py-3 text-sm font-semibold shadow-sm transition flex items-center justify-center gap-2 disabled:opacity-60 cursor-pointer mt-2"
            >
              {isAuthenticating ? (
                <>
                  <RefreshCw size={15} className="animate-spin" />
                  <span>Verifying Credentials...</span>
                </>
              ) : (
                <span>Authorize & Open Admin Panel</span>
              )}
            </button>

            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-xl border border-slate-200 bg-white py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 transition cursor-pointer"
            >
              Return to Storefront
            </button>
          </form>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW: Main Authenticated Admin Workspace
  // -------------------------------------------------------------
  return (
    <div className="fixed inset-0 z-50 flex bg-slate-50 text-slate-900 font-sans dark:bg-slate-950 dark:text-slate-100 overflow-hidden animate-in fade-in duration-150">
      {/* Floating Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-xl bg-slate-900 text-white px-4 py-3 text-xs font-semibold shadow-2xl border border-slate-800 animate-in slide-in-from-bottom-3">
          <Check size={14} className="text-teal-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* SIDEBAR NAVIGATION - DESKTOP & MOBILE DRAWER */}
      {/* Mobile Drawer Backdrop */}
      {isMobileNavOpen && (
        <div
          onClick={() => setIsMobileNavOpen(false)}
          className="fixed inset-0 bg-slate-950/60 z-40 lg:hidden backdrop-blur-xs transition-opacity"
        />
      )}

      {/* Sidebar container */}
      <aside
        className={`fixed lg:static top-0 bottom-0 left-0 z-50 w-64 border-r border-slate-200 bg-white flex flex-col justify-between dark:bg-slate-900 dark:border-slate-800 shrink-0 transition-transform duration-300 lg:translate-x-0 ${
          isMobileNavOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        }`}
      >
        <div>
          {/* Brand Header */}
          <div className="p-4 sm:p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-teal-600 text-white flex items-center justify-center font-black text-sm">
                DP
              </div>
              <div>
                <h1 className="text-sm font-bold tracking-tight text-slate-900 dark:text-white leading-tight">
                  Drum Palace
                </h1>
                <span className="text-[10px] text-slate-400 font-medium">Store Management</span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setIsMobileNavOpen(false)}
                title="Close Menu"
                className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                <X size={16} />
              </button>
              <button
                onClick={onClose}
                title="Return to Storefront"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                <ArrowLeft size={16} />
              </button>
            </div>
          </div>

          {/* Navigation Menu */}
          <nav className="p-3 space-y-1 overflow-y-auto max-h-[calc(100vh-140px)]">
            <button
              onClick={() => {
                setCurrentTab("overview");
                setIsMobileNavOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                currentTab === "overview"
                  ? "bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-400"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <LayoutDashboard size={16} />
              <span>Dashboard Overview</span>
            </button>

            <button
              onClick={() => {
                setCurrentTab("products");
                setIsMobileNavOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                currentTab === "products"
                  ? "bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-400"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <div className="flex items-center gap-3">
                <Package size={16} />
                <span>Product Catalog</span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200/60 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold">
                {products.length}
              </span>
            </button>

            <button
              onClick={() => {
                setCurrentTab("hot_deals");
                setIsMobileNavOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                currentTab === "hot_deals"
                  ? "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400 font-bold"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <div className="flex items-center gap-3">
                <Flame size={16} className={currentTab === "hot_deals" ? "text-rose-500" : "text-slate-400"} />
                <span>Hot Deals & Offers</span>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                currentTab === "hot_deals"
                  ? "bg-rose-200/70 text-rose-800 dark:bg-rose-900 dark:text-rose-200"
                  : "bg-slate-200/60 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              }`}>
                {(storeSettings.hotDeals || DEFAULT_HOT_DEALS).filter(d => d.active).length}/8
              </span>
            </button>

            <button
              onClick={() => {
                setCurrentTab("site_editor");
                setIsMobileNavOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                currentTab === "site_editor"
                  ? "bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-400"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <Sliders size={16} />
              <span>Edit Site Content</span>
            </button>

            <button
              onClick={() => {
                setCurrentTab("orders");
                setIsMobileNavOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                currentTab === "orders"
                  ? "bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-400"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <div className="flex items-center gap-3">
                <ShoppingBag size={16} />
                <span>Customer Orders</span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200/60 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold">
                {orders.length}
              </span>
            </button>

            <button
              onClick={() => {
                setCurrentTab("customers");
                setIsMobileNavOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                currentTab === "customers"
                  ? "bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-400"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <Users size={16} />
              <span>Accounts & Staff</span>
            </button>

            <button
              onClick={() => {
                setCurrentTab("livepay");
                setIsMobileNavOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                currentTab === "livepay"
                  ? "bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-400"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <CreditCard size={16} />
              <span>LivePay Gateway</span>
            </button>

            <button
              onClick={() => {
                setCurrentTab("cloud_sync");
                setIsMobileNavOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                currentTab === "cloud_sync"
                  ? "bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-400"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              }`}
            >
              <Database size={16} />
              <span>Cloud Storage & Engine</span>
            </button>
          </nav>
        </div>

        {/* Admin Footer Info */}
        <div className="p-3 sm:p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
          <div className="flex items-center justify-between">
            <div className="truncate pr-2">
              <p className="text-xs font-bold text-slate-900 dark:text-white truncate">
                {effectiveAdmin.name}
              </p>
              <p className="text-[10px] text-slate-400 truncate">{effectiveAdmin.email}</p>
            </div>
            <button
              onClick={handleAdminSignOut}
              title="Sign Out"
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      </aside>

      {/* MAIN WORKSPACE CONTENT */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top Action Bar */}
        <header className="h-14 sm:h-16 border-b border-slate-200 bg-white px-3 sm:px-6 flex items-center justify-between dark:bg-slate-900 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              onClick={() => setIsMobileNavOpen(true)}
              className="lg:hidden p-1.5 rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 transition"
              title="Open Navigation Menu"
            >
              <Menu size={20} />
            </button>
            <h2 className="text-xs sm:text-sm md:text-base font-bold text-slate-900 dark:text-white truncate">
              {currentTab === "overview" && "Dashboard Overview"}
              {currentTab === "products" && "Product Catalog"}
              {currentTab === "hot_deals" && "Hot Deals & Offers"}
              {currentTab === "site_editor" && "Site Content"}
              {currentTab === "orders" && "Customer Orders"}
              {currentTab === "customers" && "Accounts & Profiles"}
              {currentTab === "livepay" && "LivePay Payment Gateway Integration (docs.livepay.me)"}
              {currentTab === "cloud_sync" && "Cloud Storage Engine"}
            </h2>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-3">
            <button
              onClick={loadData}
              disabled={loading}
              className="flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 transition cursor-pointer shadow-sm disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              <span className="hidden xs:inline">Refresh</span>
            </button>

            <button
              onClick={handleAdminSignOut}
              className="flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold transition cursor-pointer shadow-sm dark:bg-rose-950/30 dark:border-rose-900/50 dark:text-rose-400"
              title="Lock Admin Session and Sign Out"
            >
              <Lock size={12} />
              <span className="hidden xs:inline">Lock</span>
            </button>

            <button
              onClick={onClose}
              className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition cursor-pointer shadow-sm dark:bg-teal-600 dark:hover:bg-teal-700"
            >
              <ArrowUpRight size={13} />
              <span>Storefront</span>
            </button>
          </div>
        </header>

        {/* Tab Body Scrollable Container */}
        <main className="flex-1 overflow-y-auto p-3 sm:p-5 md:p-6">
          {/* ========================================================= */}
          {/* TAB 1: OVERVIEW & PERFORMANCE */}
          {/* ========================================================= */}
          {currentTab === "overview" && (
            <div className="space-y-6 max-w-6xl">
              {/* Metrics Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-5 rounded-2xl bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 shadow-sm">
                  <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
                    <span>Total Sales Volume</span>
                    <DollarSign size={16} className="text-teal-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-900 dark:text-white mt-2">
                    {formatMoney(totalRevenue, currency)}
                  </div>
                  <div className="text-[11px] text-teal-600 font-medium mt-1 flex items-center gap-1">
                    <TrendingUp size={12} />
                    <span>Real-time processed revenue</span>
                  </div>
                </div>

                <div className="p-5 rounded-2xl bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 shadow-sm">
                  <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
                    <span>Active Orders</span>
                    <ShoppingBag size={16} className="text-blue-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-900 dark:text-white mt-2">
                    {orders.length}
                  </div>
                  <div className="text-[11px] text-slate-400 font-medium mt-1">
                    {orders.filter(o => o.status === 'Processing').length} pending dispatch
                  </div>
                </div>

                <div className="p-5 rounded-2xl bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 shadow-sm">
                  <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
                    <span>Catalog Items</span>
                    <Package size={16} className="text-indigo-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-900 dark:text-white mt-2">
                    {products.length}
                  </div>
                  <div className="text-[11px] text-slate-400 font-medium mt-1">
                    Across {categories.length - 1} pro sound categories
                  </div>
                </div>

                <div className="p-5 rounded-2xl bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 shadow-sm">
                  <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
                    <span>Registered Accounts</span>
                    <Users size={16} className="text-amber-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-900 dark:text-white mt-2">
                    {profiles.length}
                  </div>
                  <div className="text-[11px] text-slate-400 font-medium mt-1">
                    Musicians, studios & sound engineers
                  </div>
                </div>
              </div>

              {/* Quick Actions & Recent Orders Split */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Recent Orders List */}
                <div className="lg:col-span-2 rounded-2xl bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-5 shadow-sm space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">Recent Store Orders</h3>
                    <button
                      onClick={() => setCurrentTab("orders")}
                      className="text-xs font-semibold text-teal-600 hover:text-teal-700 dark:text-teal-400"
                    >
                      View all orders &rarr;
                    </button>
                  </div>

                  {orders.length === 0 ? (
                    <div className="text-center py-10 text-xs text-slate-400">
                      No customer orders placed yet.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800">
                      {orders.slice(0, 5).map((order) => (
                        <div key={order.id} className="py-3 flex items-center justify-between text-xs">
                          <div>
                            <div className="font-bold text-slate-900 dark:text-white">
                              {order.orderNumber} · {order.customerName}
                            </div>
                            <div className="text-slate-400 mt-0.5">
                              {order.items.length} item(s) · {new Date(order.createdAt).toLocaleDateString()}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold text-slate-900 dark:text-white">
                              {formatMoney(order.total, currency)}
                            </div>
                            <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold mt-0.5 ${
                              order.status === 'Delivered'
                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                                : order.status === 'Shipped'
                                ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400'
                                : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
                            }`}>
                              {order.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Store Management Shortcuts */}
                <div className="rounded-2xl bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 p-5 shadow-sm space-y-3">
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">Store Shortcuts</h3>
                  <div className="space-y-2">
                    <button
                      onClick={handleOpenNewProduct}
                      className="w-full p-3 rounded-xl border border-slate-100 hover:border-teal-200 hover:bg-teal-50/50 dark:border-slate-800 dark:hover:bg-slate-800/50 transition flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5">
                        <Plus size={15} className="text-teal-600" />
                        <span>Add New Instrument to Catalog</span>
                      </div>
                      <ChevronRight size={14} className="text-slate-400" />
                    </button>

                    <button
                      onClick={() => setCurrentTab("hot_deals")}
                      className="w-full p-3 rounded-xl border border-slate-100 hover:border-rose-200 hover:bg-rose-50/50 dark:border-slate-800 dark:hover:bg-slate-800/50 transition flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5">
                        <Flame size={15} className="text-rose-600" />
                        <span>Manage Hot Deals & Discounts ({(storeSettings.hotDeals || DEFAULT_HOT_DEALS).filter(d => d.active).length}/8)</span>
                      </div>
                      <ChevronRight size={14} className="text-slate-400" />
                    </button>

                    <button
                      onClick={() => setCurrentTab("site_editor")}
                      className="w-full p-3 rounded-xl border border-slate-100 hover:border-teal-200 hover:bg-teal-50/50 dark:border-slate-800 dark:hover:bg-slate-800/50 transition flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5">
                        <Sliders size={15} className="text-teal-600" />
                        <span>Edit Announcement & Hero Text</span>
                      </div>
                      <ChevronRight size={14} className="text-slate-400" />
                    </button>

                    <button
                      onClick={() => setCurrentTab("cloud_sync")}
                      className="w-full p-3 rounded-xl border border-slate-100 hover:border-teal-200 hover:bg-teal-50/50 dark:border-slate-800 dark:hover:bg-slate-800/50 transition flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5">
                        <Database size={15} className="text-teal-600" />
                        <span>Sync Database & Backup</span>
                      </div>
                      <ChevronRight size={14} className="text-slate-400" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* TAB 2: PRODUCT CATALOG & INVENTORY */}
          {/* ========================================================= */}
          {currentTab === "products" && (
            <div className="space-y-4 max-w-6xl">
              {/* Toolbar */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
                <div className="flex items-center gap-2 flex-1 max-w-md">
                  <div className="relative w-full">
                    <Search size={15} className="absolute left-3 top-3 text-slate-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search instruments, amplifiers, accessories..."
                      className="w-full pl-9 pr-4 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:border-teal-500 dark:bg-slate-800 dark:border-slate-700 dark:text-white"
                    />
                  </div>
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="py-2 px-3 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                  >
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={handleOpenNewProduct}
                  className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold transition shadow-sm cursor-pointer"
                >
                  <Plus size={15} />
                  <span>Add Product</span>
                </button>
              </div>

              {/* Products Table */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-100 dark:border-slate-800">
                      <tr>
                        <th className="py-3 px-4">Item</th>
                        <th className="py-3 px-4">Category</th>
                        <th className="py-3 px-4">Price</th>
                        <th className="py-3 px-4">Rating</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {filteredProducts.map((prod) => (
                        <tr key={prod.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition">
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <div className="w-11 h-11 rounded-lg overflow-hidden bg-slate-100 relative shrink-0 border border-slate-200 dark:border-slate-700">
                                <Image
                                  src={prod.image}
                                  alt={prod.name}
                                  fill
                                  sizes="44px"
                                  className="object-cover"
                                  referrerPolicy="no-referrer"
                                />
                              </div>
                              <div>
                                <div className="font-bold text-slate-900 dark:text-white">{prod.name}</div>
                                <div className="text-[11px] text-slate-400 truncate max-w-xs">{prod.subtitle || prod.description}</div>
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-4 font-medium text-slate-600 dark:text-slate-300">
                            {prod.category}
                          </td>
                          <td className="py-3 px-4 font-bold text-slate-900 dark:text-white">
                            {formatMoney(prod.price, currency)}
                          </td>
                          <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                            ★ {prod.rating || 4.9} ({prod.reviewsCount || 10})
                          </td>
                          <td className="py-3 px-4">
                            <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                              Active
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => handleOpenEditProduct(prod)}
                                title="Edit Product"
                                className="p-1.5 rounded-lg text-slate-500 hover:text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-950/50 transition cursor-pointer"
                              >
                                <Edit size={14} />
                              </button>
                              <button
                                onClick={() => handleDeleteProduct(prod)}
                                title="Delete Product"
                                className="p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition cursor-pointer"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* TAB: HOT DEALS & PROMOTIONS (MAX 8 SLIDES) */}
          {/* ========================================================= */}
          {currentTab === "hot_deals" && (
            <div className="space-y-6 max-w-5xl">
              {/* Header Card */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-rose-500/10 text-rose-500 dark:bg-rose-500/20">
                        <Flame size={18} className="text-rose-500" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                          Hot Deals & Promotional Offers Manager
                        </h3>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Control the horizontal flash deals carousel on the homepage (max 8 slides). Set custom discount rates, badges, and rotation order.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleResetHotDeals}
                      className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-semibold transition cursor-pointer"
                    >
                      Reset Defaults
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        saveStoreSettings(storeSettings);
                        showToast("Hot Deals updated and published live!");
                      }}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition shadow-sm cursor-pointer"
                    >
                      <Save size={14} />
                      <span>Publish Deals Live</span>
                    </button>
                  </div>
                </div>

                {/* Slots Status Meter */}
                <div className="mt-4 p-3.5 rounded-xl bg-rose-50/50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-rose-800 dark:text-rose-300">
                      Active Carousel Slots:
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white text-[11px] font-extrabold">
                      {(storeSettings.hotDeals || DEFAULT_HOT_DEALS).length}/8 Configured
                    </span>
                    <span className="text-[11px] text-rose-600 dark:text-rose-400">
                      ({(storeSettings.hotDeals || DEFAULT_HOT_DEALS).filter(d => d.active).length} visible on storefront)
                    </span>
                  </div>

                  {/* Slot Visual Indicators */}
                  <div className="flex items-center gap-1">
                    {Array.from({ length: 8 }).map((_, i) => {
                      const deal = (storeSettings.hotDeals || DEFAULT_HOT_DEALS)[i];
                      const isOccupied = !!deal;
                      const isActive = isOccupied && deal.active;
                      return (
                        <div
                          key={i}
                          title={isOccupied ? `Slot ${i + 1}: ${deal.customBadge || 'Deal'} (${deal.discountPercent}% OFF)` : `Slot ${i + 1}: Empty`}
                          className={`w-6 h-6 rounded-md text-[10px] font-bold flex items-center justify-center transition ${
                            isActive
                              ? "bg-rose-600 text-white shadow-sm"
                              : isOccupied
                              ? "bg-rose-200 dark:bg-rose-900 text-rose-700 dark:text-rose-300"
                              : "bg-slate-100 dark:bg-slate-800 text-slate-400 border border-dashed border-slate-300 dark:border-slate-700"
                          }`}
                        >
                          {i + 1}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ADD NEW PRODUCT TO HOT DEALS FORM */}
                {(storeSettings.hotDeals || DEFAULT_HOT_DEALS).length < 8 && (
                  <form
                    onSubmit={handleAddProductToHotDeals}
                    className="mt-4 p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                        <Plus size={14} className="text-rose-600" />
                        <span>Add Product to Hot Deals (Slot #{(storeSettings.hotDeals || DEFAULT_HOT_DEALS).length + 1})</span>
                      </h4>
                      <span className="text-[10px] text-slate-400">
                        {8 - (storeSettings.hotDeals || DEFAULT_HOT_DEALS).length} slots remaining
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                      {/* Product Selector */}
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">
                          Select Product *
                        </label>
                        <select
                          required
                          value={selectedProductForDeal}
                          onChange={(e) => setSelectedProductForDeal(e.target.value)}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:border-rose-500 dark:bg-slate-900 dark:border-slate-700 dark:text-white font-medium"
                        >
                          <option value="">-- Choose item from store --</option>
                          {products
                            .filter(
                              (p) => !(storeSettings.hotDeals || DEFAULT_HOT_DEALS).some((d) => d.productId === p.id)
                            )
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name} ({p.category}) - {formatMoney(p.price, currency)}
                              </option>
                            ))}
                        </select>
                      </div>

                      {/* Custom Title (Optional) */}
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">
                          Custom Headline (Optional)
                        </label>
                        <input
                          type="text"
                          value={newDealCustomTitle}
                          onChange={(e) => setNewDealCustomTitle(e.target.value)}
                          placeholder="e.g. Flash 40% Off Drum Kit"
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:border-rose-500 dark:bg-slate-900 dark:border-slate-700 dark:text-white font-medium"
                        />
                      </div>

                      {/* Discount % Input */}
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">
                          Discount Percentage
                        </label>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min="1"
                            max="90"
                            value={newDealDiscount}
                            onChange={(e) => setNewDealDiscount(Math.max(1, Math.min(90, Number(e.target.value) || 0)))}
                            className="w-16 px-2.5 py-2 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:border-rose-500 dark:bg-slate-900 dark:border-slate-700 dark:text-white font-bold text-center"
                          />
                          <span className="text-xs font-bold text-rose-600">%</span>

                          {/* Quick preset buttons */}
                          <div className="flex items-center gap-1 ml-auto">
                            {[20, 30, 40, 50].map((d) => (
                              <button
                                key={d}
                                type="button"
                                onClick={() => setNewDealDiscount(d)}
                                className={`px-1.5 py-1 rounded text-[10px] font-bold border transition ${
                                  newDealDiscount === d
                                    ? "bg-rose-600 text-white border-rose-600"
                                    : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-rose-400"
                                }`}
                              >
                                {d}%
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Promotional Badge & Submit */}
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">
                          Badge Label
                        </label>
                        <input
                          type="text"
                          value={newDealBadge}
                          onChange={(e) => setNewDealBadge(e.target.value)}
                          placeholder="e.g. Flash Deal"
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:border-rose-500 dark:bg-slate-900 dark:border-slate-700 dark:text-white font-medium"
                        />
                      </div>
                    </div>

                    {/* Optional Custom Image & Action Row */}
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2 border-t border-slate-200/60 dark:border-slate-700/60">
                      <div className="flex-1 w-full flex items-center gap-2">
                        <label className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:border-rose-400 transition cursor-pointer">
                          <Upload size={12} className="text-rose-600" />
                          <span>Upload Custom Deal Photo</span>
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={async (e) => {
                              if (e.target.files?.[0]) {
                                const f = e.target.files[0];
                                showToast("Uploading deal photo...");
                                const res = await uploadImageToSupabaseStorage(f, f.name, "products");
                                if (res.success && res.url) {
                                  setNewDealCustomImage(res.url);
                                  showToast("Custom photo uploaded!");
                                } else {
                                  alert(res.error || "Failed to upload photo");
                                }
                              }
                            }}
                          />
                        </label>

                        <input
                          type="text"
                          value={newDealCustomImage}
                          onChange={(e) => setNewDealCustomImage(e.target.value)}
                          placeholder="Or paste custom image link (optional)"
                          className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700 dark:text-white font-mono"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={!selectedProductForDeal}
                        className="w-full sm:w-auto px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition shadow-sm disabled:opacity-50 cursor-pointer shrink-0"
                      >
                        Add to Hot Deals Carousel
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* CONFIGURED HOT DEALS LIST */}
              <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                    Configured Slides ({(storeSettings.hotDeals || DEFAULT_HOT_DEALS).length} of 8)
                  </h4>
                  <span className="text-[11px] text-slate-400">
                    Drag or use up/down arrows to reorder slide sequence
                  </span>
                </div>

                {(storeSettings.hotDeals || DEFAULT_HOT_DEALS).map((deal, idx, arr) => {
                  const prod = products.find((p) => p.id === deal.productId);
                  const regularPrice = prod ? prod.price : 1000000;
                  const discountVal = deal.discountPercent || 25;
                  const salePrice = Math.round(regularPrice * (1 - discountVal / 100));
                  const savings = regularPrice - salePrice;
                  const displayImage = deal.customImage?.trim() || prod?.image || "https://picsum.photos/seed/drum-deal/600/450";
                  const hasCustomImage = Boolean(deal.customImage?.trim());

                  return (
                    <div
                      key={deal.id || idx}
                      className={`p-4 sm:p-5 rounded-2xl bg-white dark:bg-slate-900 border shadow-sm flex flex-col gap-4 transition ${
                        deal.active
                          ? "border-slate-200 dark:border-slate-800 hover:border-rose-300 dark:hover:border-rose-700"
                          : "border-dashed border-slate-200 dark:border-slate-800 opacity-70 bg-slate-50/60"
                      }`}
                    >
                      {/* Top Header Row: Slot, Product Selection, Active toggle, Reorder, Delete */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
                        <div className="flex items-center gap-2">
                          <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 text-xs font-black">
                            #{idx + 1}
                          </span>
                          <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                            {deal.customTitle?.trim() || prod?.name || "Deal Item"}
                          </span>
                          {hasCustomImage && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-300">
                              Custom Photo
                            </span>
                          )}
                          {!deal.active && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                              Hidden
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {/* Enable/Disable Toggle */}
                          <button
                            type="button"
                            onClick={() => handleToggleDealActive(idx)}
                            title={deal.active ? "Hide deal from storefront" : "Show deal on storefront"}
                            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold border transition cursor-pointer ${
                              deal.active
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-400"
                                : "bg-slate-100 text-slate-400 border-slate-200 dark:bg-slate-800 dark:border-slate-700"
                            }`}
                          >
                            {deal.active ? <Eye size={13} /> : <EyeOff size={13} />}
                            <span>{deal.active ? "Active" : "Hidden"}</span>
                          </button>

                          {/* Reorder Buttons */}
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => handleMoveHotDeal(idx, "up")}
                            title="Move earlier in slider sequence"
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-30 cursor-pointer"
                          >
                            <ArrowUp size={13} />
                          </button>
                          <button
                            type="button"
                            disabled={idx === arr.length - 1}
                            onClick={() => handleMoveHotDeal(idx, "down")}
                            title="Move later in slider sequence"
                            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-30 cursor-pointer"
                          >
                            <ArrowDown size={13} />
                          </button>

                          {/* Delete Deal */}
                          <button
                            type="button"
                            onClick={() => handleRemoveHotDeal(deal.id)}
                            title="Remove from hot deals"
                            className="p-1.5 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:border-rose-900 dark:text-rose-400 transition cursor-pointer"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {/* Main Deal Body: Left (Picture & Upload) | Right (Form Details) */}
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
                        {/* PICTURE MANAGEMENT SECTION */}
                        <div className="md:col-span-4 flex flex-col gap-2">
                          <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center justify-between">
                            <span>Deal Picture</span>
                            {hasCustomImage && (
                              <button
                                type="button"
                                onClick={() => handleUpdateDealField(idx, "customImage", "")}
                                className="text-[10px] text-rose-500 hover:underline cursor-pointer"
                              >
                                Revert to Default
                              </button>
                            )}
                          </label>

                          {/* Image Preview Container */}
                          <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 group">
                            <Image
                              src={displayImage}
                              alt={deal.customTitle || prod?.name || "Deal image"}
                              fill
                              sizes="(max-width: 768px) 100vw, 250px"
                              className="object-cover transition group-hover:scale-105"
                              referrerPolicy="no-referrer"
                            />
                            <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-rose-600 text-white shadow-sm">
                              -{discountVal}%
                            </div>
                            {deal.customBadge && (
                              <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md text-[9px] font-bold bg-black/70 text-white backdrop-blur-xs">
                                {deal.customBadge}
                              </div>
                            )}
                          </div>

                          {/* Picture Action Buttons */}
                          <div className="flex items-center gap-2">
                            <label className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900/50 text-xs font-bold transition cursor-pointer text-center">
                              <Upload size={13} />
                              <span>Upload Picture</span>
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                  if (e.target.files?.[0]) {
                                    handleDealImageFileUpload(e.target.files[0], idx);
                                  }
                                }}
                              />
                            </label>
                          </div>

                          {/* Image URL Direct Input */}
                          <div>
                            <input
                              type="text"
                              value={deal.customImage || ""}
                              onChange={(e) => handleUpdateDealField(idx, "customImage", e.target.value)}
                              placeholder="Or paste image URL (https://...)"
                              className="w-full px-2.5 py-1.5 text-[11px] rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-mono"
                            />
                          </div>
                        </div>

                        {/* EDITABLE FIELDS SECTION */}
                        <div className="md:col-span-8 space-y-3">
                          {/* Associated Product Selector */}
                          <div>
                            <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                              Linked Store Product
                            </label>
                            <select
                              value={deal.productId}
                              onChange={(e) => handleUpdateDealField(idx, "productId", e.target.value)}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                            >
                              {products.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} ({p.category}) — {formatMoney(p.price, currency)}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Custom Title Override */}
                          <div>
                            <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                              Promotional Title / Headline
                            </label>
                            <input
                              type="text"
                              value={deal.customTitle || ""}
                              onChange={(e) => handleUpdateDealField(idx, "customTitle", e.target.value)}
                              placeholder={prod ? `Default: ${prod.name}` : "Enter custom deal title..."}
                              className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                            />
                          </div>

                          {/* Discount % & Badge Label */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                                Discount Percentage
                              </label>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  min="1"
                                  max="90"
                                  value={deal.discountPercent}
                                  onChange={(e) =>
                                    handleUpdateDealField(
                                      idx,
                                      "discountPercent",
                                      Math.max(1, Math.min(90, Number(e.target.value) || 0))
                                    )
                                  }
                                  className="w-20 px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-bold text-center"
                                />
                                <span className="text-xs font-bold text-rose-600">% OFF</span>

                                <div className="flex items-center gap-1 ml-auto">
                                  {[15, 25, 35, 50].map((d) => (
                                    <button
                                      key={d}
                                      type="button"
                                      onClick={() => handleUpdateDealField(idx, "discountPercent", d)}
                                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition ${
                                        deal.discountPercent === d
                                          ? "bg-rose-600 text-white border-rose-600"
                                          : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-rose-400"
                                      }`}
                                    >
                                      {d}%
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>

                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">
                                Promotional Badge
                              </label>
                              <input
                                type="text"
                                value={deal.customBadge || ""}
                                onChange={(e) => handleUpdateDealField(idx, "customBadge", e.target.value)}
                                placeholder="Flash Deal / Limited Stock"
                                className="w-full px-3 py-1.5 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                              />
                            </div>
                          </div>

                          {/* Live Calculated Price Summary */}
                          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700 flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div className="flex items-center gap-3">
                              <span className="text-slate-400 line-through">
                                Reg: {formatMoney(regularPrice, currency)}
                              </span>
                              <span className="font-extrabold text-rose-600 dark:text-rose-400 text-sm">
                                Deal: {formatMoney(salePrice, currency)}
                              </span>
                            </div>
                            <span className="text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-lg border border-emerald-200 dark:border-emerald-900/40">
                              Customer saves {formatMoney(savings, currency)} ({discountVal}%)
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {/* ========================================================= */}
          {currentTab === "site_editor" && (
            <div className="max-w-4xl space-y-6">
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
                <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">Storefront Live Editor</h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Customize announcement messages, hero headlines, badges, and contact details displayed on the site.
                    </p>
                  </div>
                  <button
                    onClick={handleSaveStoreCustomizer}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold transition shadow-sm cursor-pointer"
                  >
                    <Save size={14} />
                    <span>Publish Changes</span>
                  </button>
                </div>

                <form onSubmit={handleSaveStoreCustomizer} className="space-y-6 pt-5">
                  {/* HERO & PROMOTIONAL BANNER SLIDES MANAGER */}
                  <div className="p-5 rounded-2xl border border-teal-100 bg-teal-50/40 dark:bg-teal-950/20 dark:border-teal-900/60 space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-teal-100 dark:border-teal-900/50">
                      <div>
                        <h4 className="text-xs font-extrabold text-teal-900 dark:text-teal-300 uppercase tracking-wider flex items-center gap-2">
                          <ImageIcon size={16} className="text-teal-600" />
                          <span>Hero Banner Carousel Slides ({(storeSettings.bannerSlides || DEFAULT_BANNER_SLIDES).length})</span>
                        </h4>
                        <p className="text-[11px] text-teal-700/80 dark:text-teal-400 mt-0.5">
                          Manage promotional slides, upload banner photos, update discount headlines, and reorder carousel rotation.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setIsAddingNewSlide(!isAddingNewSlide)}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-bold transition shadow-sm cursor-pointer"
                        >
                          <Plus size={13} />
                          <span>{isAddingNewSlide ? "Hide Add Form" : "Add New Slide"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleResetBannerSlides}
                          className="px-2.5 py-1.5 rounded-lg border border-teal-200 dark:border-teal-800 text-teal-800 dark:text-teal-300 hover:bg-teal-100/50 text-[11px] font-semibold transition cursor-pointer"
                        >
                          Reset Defaults
                        </button>
                      </div>
                    </div>

                    {/* NEW SLIDE CREATION CARD */}
                    {isAddingNewSlide && (
                      <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-teal-200 dark:border-teal-800 shadow-md space-y-3 animate-in fade-in duration-200">
                        <h5 className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                          <Plus size={14} className="text-teal-600" />
                          <span>Create New Carousel Slide</span>
                        </h5>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Slide Main Caption / Headline</label>
                            <input
                              type="text"
                              value={newSlideForm.caption || ""}
                              onChange={(e) => setNewSlideForm({ ...newSlideForm, caption: e.target.value })}
                              placeholder="e.g. Mega Weekend Flash Sale"
                              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                            />
                          </div>

                          <div className="space-y-1">
                            <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Secondary Subtitle</label>
                            <input
                              type="text"
                              value={newSlideForm.subtext || ""}
                              onChange={(e) => setNewSlideForm({ ...newSlideForm, subtext: e.target.value })}
                              placeholder="e.g. Up to 40% OFF all acoustic drums & accessories"
                              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Button CTA Label</label>
                            <input
                              type="text"
                              value={newSlideForm.ctaText || ""}
                              onChange={(e) => setNewSlideForm({ ...newSlideForm, ctaText: e.target.value })}
                              placeholder="e.g. Shop Now"
                              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                            />
                          </div>

                          <div className="space-y-1">
                            <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Category Destination Link</label>
                            <select
                              value={newSlideForm.categoryFilter || "all"}
                              onChange={(e) => setNewSlideForm({ ...newSlideForm, categoryFilter: e.target.value })}
                              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                            >
                              <option value="all">All Products</option>
                              <option value="drums">Drums & Cymbals</option>
                              <option value="guitars">Guitars & Bass</option>
                              <option value="keyboards">Keyboards & Pianos</option>
                              <option value="mixers">Audio & Studio Mixers</option>
                              <option value="speakers">PA Speakers & Systems</option>
                              <option value="lighting">Stage Lighting</option>
                            </select>
                          </div>
                        </div>

                        {/* Slide Image Input & Upload */}
                        <div className="space-y-1.5 pt-1">
                          <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 flex items-center justify-between">
                            <span>Banner Image Source</span>
                            <span className="text-[10px] text-slate-400">Recommended size: 1200 x 320 px</span>
                          </label>

                          <div className="flex gap-2 items-center">
                            <input
                              type="text"
                              value={newSlideForm.image || ""}
                              onChange={(e) => setNewSlideForm({ ...newSlideForm, image: e.target.value })}
                              placeholder="Paste HTTPS image URL or upload below..."
                              className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-mono text-[11px]"
                            />
                            <label className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold cursor-pointer border border-slate-200 dark:border-slate-700 shrink-0">
                              <Upload size={14} />
                              <span>Upload Photo</span>
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                  if (e.target.files?.[0]) {
                                    handleSlideImageFileUpload(e.target.files[0], true);
                                  }
                                }}
                              />
                            </label>
                          </div>

                          {/* Quick Photo Presets */}
                          <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[10px] text-slate-500">
                            <span>Quick Presets:</span>
                            <button
                              type="button"
                              onClick={() => setNewSlideForm((prev) => ({ ...prev, image: "https://images.unsplash.com/photo-1519892300165-cb5542fb47c7?auto=format&fit=crop&w=1200&q=85", caption: "Acoustic Drum Mastery", subtext: "Mastercrafted shells & cymbals" }))}
                              className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-teal-50 hover:text-teal-700 border border-slate-200 dark:border-slate-700"
                            >
                              🥁 Drum Kit
                            </button>
                            <button
                              type="button"
                              onClick={() => setNewSlideForm((prev) => ({ ...prev, image: "https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=1200&q=85", caption: "Live Stage Concerts", subtext: "Touring gear engineered for power" }))}
                              className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-teal-50 hover:text-teal-700 border border-slate-200 dark:border-slate-700"
                            >
                              🎸 Stage Guitars
                            </button>
                            <button
                              type="button"
                              onClick={() => setNewSlideForm((prev) => ({ ...prev, image: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?auto=format&fit=crop&w=1200&q=85", caption: "Pro Studio Mixers", subtext: "Zero-latency multi-track digital audio" }))}
                              className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-teal-50 hover:text-teal-700 border border-slate-200 dark:border-slate-700"
                            >
                              🎛️ Studio Mixers
                            </button>
                            <button
                              type="button"
                              onClick={() => setNewSlideForm((prev) => ({ ...prev, image: "https://images.unsplash.com/photo-1520523839898-507125ef5381?auto=format&fit=crop&w=1200&q=85", caption: "Grand Digital Keyboards", subtext: "Weighted graded hammer action keys" }))}
                              className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-teal-50 hover:text-teal-700 border border-slate-200 dark:border-slate-700"
                            >
                              🎹 Keyboards
                            </button>
                          </div>

                          {/* Live Preview of New Slide */}
                          {newSlideForm.image && (
                            <div className="relative h-20 w-full rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 mt-2 bg-black flex items-end p-3">
                              <Image
                                src={newSlideForm.image}
                                alt="Slide preview"
                                fill
                                className="object-cover brightness-75"
                                referrerPolicy="no-referrer"
                              />
                              <div className="relative z-10 text-white">
                                <p className="text-xs font-bold leading-tight">{newSlideForm.caption || "Sample Headline"}</p>
                                <p className="text-[10px] text-slate-200 opacity-90">{newSlideForm.subtext || "Sample subtitle text"}</p>
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="flex justify-end gap-2 pt-2">
                          <button
                            type="button"
                            onClick={() => setIsAddingNewSlide(false)}
                            className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-xs font-semibold"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleAddBannerSlide}
                            className="px-4 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold transition shadow-sm cursor-pointer"
                          >
                            Add to Carousel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* EXISTING SLIDES LIST */}
                    <div className="space-y-3">
                      {(storeSettings.bannerSlides || DEFAULT_BANNER_SLIDES).map((slide, idx, arr) => (
                        <div
                          key={slide.id || idx}
                          className="p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col md:flex-row md:items-center gap-4 transition hover:border-teal-300 dark:hover:border-teal-700"
                        >
                          {/* Slide Thumbnail Preview */}
                          <div className="relative w-full md:w-36 h-20 rounded-lg overflow-hidden bg-black shrink-0 border border-slate-200 dark:border-slate-700 flex items-end p-2">
                            <Image
                              src={slide.image}
                              alt={slide.caption}
                              fill
                              className="object-cover brightness-75"
                              referrerPolicy="no-referrer"
                            />
                            <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-white uppercase tracking-wider z-10">
                              Slide #{idx + 1}
                            </div>
                          </div>

                          {/* Slide Text Inputs */}
                          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase">Slide Headline</label>
                              <input
                                type="text"
                                value={slide.caption}
                                onChange={(e) => handleUpdateSlideField(idx, "caption", e.target.value)}
                                className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase">Subtitle</label>
                              <input
                                type="text"
                                value={slide.subtext || ""}
                                onChange={(e) => handleUpdateSlideField(idx, "subtext", e.target.value)}
                                className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase">Button Text</label>
                              <input
                                type="text"
                                value={slide.ctaText || ""}
                                onChange={(e) => handleUpdateSlideField(idx, "ctaText", e.target.value)}
                                className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase flex items-center justify-between">
                                <span>Image URL / Upload</span>
                                <label className="text-[10px] text-teal-600 hover:text-teal-700 font-bold cursor-pointer inline-flex items-center gap-1">
                                  <Upload size={10} />
                                  <span>Replace Photo</span>
                                  <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={(e) => {
                                      if (e.target.files?.[0]) {
                                        handleSlideImageFileUpload(e.target.files[0], false, idx);
                                      }
                                    }}
                                  />
                                </label>
                              </label>
                              <input
                                type="text"
                                value={slide.image}
                                onChange={(e) => handleUpdateSlideField(idx, "image", e.target.value)}
                                className="w-full px-2.5 py-1.5 text-[11px] rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-mono"
                              />
                            </div>
                          </div>

                          {/* Reorder & Action Controls */}
                          <div className="flex md:flex-col items-center justify-end gap-1.5 shrink-0 pt-2 md:pt-0 border-t md:border-t-0 border-slate-100 dark:border-slate-800">
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                disabled={idx === 0}
                                onClick={() => handleMoveBannerSlide(idx, "up")}
                                title="Move slide earlier in rotation"
                                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-30 cursor-pointer"
                              >
                                <ArrowUp size={13} />
                              </button>
                              <button
                                type="button"
                                disabled={idx === arr.length - 1}
                                onClick={() => handleMoveBannerSlide(idx, "down")}
                                title="Move slide later in rotation"
                                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-30 cursor-pointer"
                              >
                                <ArrowDown size={13} />
                              </button>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleDeleteBannerSlide(slide.id)}
                              title="Delete slide"
                              className="p-1.5 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:border-rose-900 dark:text-rose-400 transition cursor-pointer"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Announcement Banner */}
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Announcement Bar Banner Text
                    </label>
                    <textarea
                      rows={2}
                      value={storeSettings.announcementText}
                      onChange={(e) => setStoreSettings({ ...storeSettings, announcementText: e.target.value })}
                      placeholder="Special promo, free delivery announcements, holiday notices..."
                      className="w-full p-3 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:border-teal-500 dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                    />
                  </div>

                  {/* Hero Headline & Subtitle */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                        Hero Main Headline
                      </label>
                      <input
                        type="text"
                        value={storeSettings.heroHeadline}
                        onChange={(e) => setStoreSettings({ ...storeSettings, heroHeadline: e.target.value })}
                        className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:border-teal-500 dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                        Hero Seasonal Badge
                      </label>
                      <input
                        type="text"
                        value={storeSettings.heroBadge}
                        onChange={(e) => setStoreSettings({ ...storeSettings, heroBadge: e.target.value })}
                        className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:border-teal-500 dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Hero Subtitle / Description
                    </label>
                    <textarea
                      rows={3}
                      value={storeSettings.heroSubtitle}
                      onChange={(e) => setStoreSettings({ ...storeSettings, heroSubtitle: e.target.value })}
                      className="w-full p-3 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:border-teal-500 dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                    />
                  </div>

                  {/* Contact Information */}
                  <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
                    <h4 className="text-xs font-bold text-slate-900 dark:text-white mb-3">Store Contact & Location Details</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">Phone Support</label>
                        <input
                          type="text"
                          value={storeSettings.contactPhone}
                          onChange={(e) => setStoreSettings({ ...storeSettings, contactPhone: e.target.value })}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">Support Email</label>
                        <input
                          type="text"
                          value={storeSettings.contactEmail}
                          onChange={(e) => setStoreSettings({ ...storeSettings, contactEmail: e.target.value })}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                        />
                      </div>

                      <div className="space-y-1.5 md:col-span-2">
                        <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">Physical Store Address</label>
                        <input
                          type="text"
                          value={storeSettings.contactAddress}
                          onChange={(e) => setStoreSettings({ ...storeSettings, contactAddress: e.target.value })}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 flex justify-end">
                    <button
                      type="submit"
                      className="px-5 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold transition shadow-sm cursor-pointer"
                    >
                      Save & Publish Storefront Changes
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* TAB 4: ORDERS & TRANSACTIONS */}
          {/* ========================================================= */}
          {currentTab === "orders" && (
            <div className="space-y-4 max-w-6xl">
              {/* Filter Tabs */}
              <div className="flex items-center gap-2 bg-white dark:bg-slate-900 p-2 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-x-auto">
                {["All", "Processing", "Shipped", "Delivered", "Cancelled"].map((status) => (
                  <button
                    key={status}
                    onClick={() => setOrderStatusFilter(status)}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                      orderStatusFilter === status
                        ? "bg-teal-600 text-white shadow-sm"
                        : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                    }`}
                  >
                    {status}
                  </button>
                ))}
              </div>

              {/* Orders List */}
              <div className="space-y-3">
                {filteredOrders.length === 0 ? (
                  <div className="bg-white dark:bg-slate-900 p-12 rounded-2xl border border-slate-200 dark:border-slate-800 text-center text-xs text-slate-400">
                    No orders matching &ldquo;{orderStatusFilter}&rdquo;.
                  </div>
                ) : (
                  filteredOrders.map((order) => (
                    <div
                      key={order.id}
                      className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-3"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800 text-xs">
                        <div>
                          <div className="font-bold text-slate-900 dark:text-white text-sm">
                            {order.orderNumber}
                          </div>
                          <div className="text-slate-400 mt-0.5">
                            Customer: <span className="text-slate-700 dark:text-slate-300 font-semibold">{order.customerName}</span> ({order.customerEmail})
                          </div>
                        </div>

                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-slate-900 dark:text-white">
                            {formatMoney(order.total, currency)}
                          </span>
                          <select
                            value={order.paymentStatus === "Paid" ? "Paid" : "Pending"}
                            onChange={(e) => handleUpdatePaymentStatus(order.id, e.target.value as any)}
                            title="Payment reconciliation (admin)"
                            className={`py-1 px-2.5 text-xs rounded-lg border font-bold focus:outline-none ${
                              order.paymentStatus === "Paid"
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-300"
                                : "border-amber-200 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-300"
                            }`}
                          >
                            <option value="Pending">Payment: Pending</option>
                            <option value="Paid">Payment: Paid</option>
                          </select>
                          <select
                            value={order.status}
                            onChange={(e) => handleUpdateOrderStatus(order.id, e.target.value as any)}
                            className="py-1 px-2.5 text-xs rounded-lg border border-slate-200 bg-slate-50 font-bold focus:outline-none dark:bg-slate-800 dark:border-slate-700"
                          >
                            <option value="Processing">Processing</option>
                            <option value="Shipped">Shipped</option>
                            <option value="Delivered">Delivered</option>
                            <option value="Cancelled">Cancelled</option>
                          </select>
                        </div>
                      </div>

                      {/* Items breakdown */}
                      <div className="text-xs space-y-1">
                        <div className="text-slate-400 font-semibold text-[11px]">Items in Order:</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {order.items.map((item, idx) => (
                            <div key={idx} className="p-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 flex justify-between">
                              <span className="font-medium">{item.quantity}x {item.productName}</span>
                              <span className="font-bold">{formatMoney(item.price * item.quantity, currency)}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {order.shippingAddress && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          <span className="font-semibold">Delivery Destination:</span> {order.shippingAddress}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* TAB 5: ACCOUNTS & ROLES */}
          {/* ========================================================= */}
          {currentTab === "customers" && (
            <div className="space-y-4 max-w-5xl">
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-100 dark:border-slate-800">
                    <tr>
                      <th className="py-3 px-4">User</th>
                      <th className="py-3 px-4">Email</th>
                      <th className="py-3 px-4">Role Permission</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {profiles.map((prof) => (
                      <tr key={prof.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition">
                        <td className="py-3 px-4 font-bold text-slate-900 dark:text-white">
                          {prof.name}
                        </td>
                        <td className="py-3 px-4 text-slate-500 dark:text-slate-400">
                          {prof.email}
                        </td>
                        <td className="py-3 px-4">
                          <select
                            value={prof.role}
                            onChange={(e) => handleUpdateUserRole(prof.id, e.target.value as any)}
                            className="py-1 px-2.5 text-xs rounded-lg border border-slate-200 bg-slate-50 font-bold focus:outline-none dark:bg-slate-800 dark:border-slate-700"
                          >
                            <option value="admin">Administrator</option>
                            <option value="staff">Staff Luthier / Audio Tech</option>
                            <option value="customer">Customer</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* TAB 6: CLOUD DATABASE & STORAGE ENGINE */}
          {/* ========================================================= */}
          {currentTab === "cloud_sync" && (
            <div className="max-w-4xl space-y-6">
              {/* Cloud Status Card */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-sm space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                      <Database size={16} className="text-teal-600" />
                      <span>Cloud Database & Synchronization Engine</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Ensures seamless real-time persistence across sessions, orders, and customer accounts.
                    </p>
                  </div>
                  <button
                    onClick={handleRunDiagnostics}
                    disabled={isTestingCloud}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition cursor-pointer dark:bg-teal-600 dark:hover:bg-teal-700 disabled:opacity-50"
                  >
                    <RefreshCw size={13} className={isTestingCloud ? "animate-spin" : ""} />
                    <span>Run Health Diagnostic</span>
                  </button>
                </div>

                {/* Diagnostic Output Checklist */}
                {diagnosticResult && (
                  <div className="space-y-2 pt-2">
                    <div className="text-xs font-bold text-slate-700 dark:text-slate-300">
                      System Integrity Status ({diagnosticResult.responseTimeMs}ms latency)
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {diagnosticResult.checks.map((chk, idx) => (
                        <div key={idx} className="p-3 rounded-xl border border-slate-100 bg-slate-50 dark:bg-slate-800/40 dark:border-slate-800 flex items-center justify-between text-xs">
                          <span className="font-semibold">{chk.name}</span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                            chk.status === 'pass' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-400' : 'bg-amber-100 text-amber-800'
                          }`}>
                            {chk.status.toUpperCase()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* 1-Click Database Population */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-sm space-y-3">
                <h4 className="text-xs font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                  Catalog Seeder & Cloud Synchronization
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Instantly synchronize the entire Drum Palace catalog (Drums, Guitars, Mixers, Lighting, Keyboards, and Speakers) to your connected cloud storage.
                </p>
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={handleSeedCatalogNow}
                    disabled={isSeedingData}
                    className="px-4 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold transition flex items-center gap-2 cursor-pointer disabled:opacity-50"
                  >
                    <Sparkles size={14} />
                    <span>{isSeedingData ? "Seeding Catalog..." : "Sync Complete Catalog to Cloud Database"}</span>
                  </button>

                  <button
                    onClick={handleCopySchemaSql}
                    className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:border-slate-700 text-xs font-semibold transition flex items-center gap-2 cursor-pointer"
                  >
                    <Copy size={14} />
                    <span>{copiedSql ? "Copied SQL Schema!" : "Copy Database Migration SQL"}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* TAB 7: LIVEPAY PAYMENT GATEWAY (https://docs.livepay.me/) */}
          {/* ========================================================= */}
          {currentTab === "livepay" && (
            <div className="max-w-5xl space-y-6">
              {/* LivePay Gateway Status Banner */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-sm space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <CreditCard size={18} className="text-teal-600" />
                        <span>LivePay Payment Integration</span>
                      </h3>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300">
                        UGX · MTN · Airtel · Cards · Crypto
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Seamless payment processing integrated via official LivePay developer specifications (
                      <a
                        href="https://docs.livepay.me/"
                        target="_blank"
                        rel="noreferrer"
                        className="text-teal-600 hover:underline font-semibold inline-flex items-center gap-1"
                      >
                        <span>docs.livepay.me</span>
                        <ExternalLink size={11} />
                      </a>
                      ).
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleTestLivepayConnection}
                      disabled={isTestingLivepay}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition cursor-pointer dark:bg-teal-600 dark:hover:bg-teal-700 disabled:opacity-50 shadow-sm"
                    >
                      <Activity size={13} className={isTestingLivepay ? "animate-spin" : ""} />
                      <span>{isTestingLivepay ? "Testing Gateway..." : "Test Gateway Handshake"}</span>
                    </button>
                    <a
                      href="https://docs.livepay.me/"
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200 text-xs font-semibold transition shadow-sm"
                    >
                      <Globe size={13} />
                      <span>Official API Docs</span>
                    </a>
                  </div>
                </div>

                {/* Diagnostic Handshake Output */}
                {livepayTestResult && (
                  <div className={`p-4 rounded-xl border text-xs space-y-2 ${
                    livepayTestResult.success
                      ? "border-emerald-200 bg-emerald-50/70 text-emerald-900 dark:bg-emerald-950/30 dark:border-emerald-900 dark:text-emerald-300"
                      : "border-amber-200 bg-amber-50/70 text-amber-900 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300"
                  }`}>
                    <div className="flex items-center justify-between font-bold">
                      <span className="flex items-center gap-1.5">
                        {livepayTestResult.success ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                        <span>Status: {livepayTestResult.status || "Diagnostic Completed"}</span>
                      </span>
                      {livepayTestResult.latencyMs !== undefined && (
                        <span className="text-[11px] font-mono opacity-80">
                          Latency: {livepayTestResult.latencyMs}ms
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] opacity-90 leading-relaxed">
                      {livepayTestResult.message || livepayTestResult.error || "Gateway response verified successfully."}
                    </p>
                    {livepayTestResult.apiUrl && (
                      <div className="text-[10px] font-mono bg-black/5 dark:bg-black/20 p-2 rounded-lg">
                        Target API Endpoint: {livepayTestResult.apiUrl}
                      </div>
                    )}
                  </div>
                )}

                {/* Supported Payment Channels Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                  <div className="p-3.5 rounded-xl border border-slate-100 bg-slate-50 dark:bg-slate-800/40 dark:border-slate-800 space-y-1">
                    <div className="font-bold text-xs text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <span>📱</span>
                      <span>Uganda Mobile Money</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Instant USSD PIN prompt directly on customer mobile devices (MTN MoMo & Airtel Money).
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl border border-slate-100 bg-slate-50 dark:bg-slate-800/40 dark:border-slate-800 space-y-1">
                    <div className="font-bold text-xs text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <span>💳</span>
                      <span>Visa & Mastercard</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Secure 3D-Secure credit & debit card processing with automated verification.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl border border-slate-100 bg-slate-50 dark:bg-slate-800/40 dark:border-slate-800 space-y-1">
                    <div className="font-bold text-xs text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <span>⚡</span>
                      <span>Instant IPN Webhooks</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Automated real-time order status updates via encrypted server-to-server webhook callbacks.
                    </p>
                  </div>
                </div>
              </div>

              {/* LivePay API Credentials & Configuration Form */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-sm space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                  <h4 className="text-xs font-bold text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                    <Key size={14} className="text-teal-600" />
                    <span>LivePay Gateway API Keys & Merchant Config</span>
                  </h4>
                  <span className="text-[10px] text-slate-400">
                    Keys are securely stored and proxied server-side via Next.js
                  </span>
                </div>

                <div className="space-y-3 text-xs">
                  <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                    LivePay credentials are intentionally <strong>not entered here</strong>. Per
                    docs.livepay.me the gateway is configured exclusively through server-side
                    environment variables so no key ever reaches the browser. Set these on the
                    hosting environment and restart:
                  </p>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-slate-300 space-y-1">
                    <div>LIVEPAY_API_KEY=<span className="text-slate-400">Bearer API key from the LivePay dashboard (sole credential)</span></div>
                    <div>LIVEPAY_MERCHANT_ID=<span className="text-slate-400">your LivePay account number, e.g. LP2305443309</span></div>
                    <div>LIVEPAY_SECRET_KEY=<span className="text-slate-400">not used by the documented API (webhook HMAC uses LIVEPAY_WEBHOOK_SECRET)</span></div>
                    <div>LIVEPAY_WEBHOOK_SECRET=<span className="text-slate-400">required for webhook acceptance (fail closed)</span></div>
                    <div>LIVEPAY_API_URL=<span className="text-slate-400">default https://livepay.me/api (docs base URL)</span></div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] text-slate-400">
                      Reference: docs.livepay.me &mdash; auth, /collect-money, /check-balance,
                      /transaction-status, /webhooks
                    </p>
                    <button
                      type="button"
                      onClick={handleTestLivepayConnection}
                      disabled={isTestingLivepay}
                      className="px-5 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-bold transition shadow-sm cursor-pointer flex items-center gap-2 shrink-0"
                    >
                      <Activity size={14} className={isTestingLivepay ? "animate-spin" : ""} />
                      <span>{isTestingLivepay ? "Testing Gateway..." : "Test Live Connection"}</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Webhook & IPN Setup Instructions */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                    <Terminal size={14} className="text-teal-600" />
                    <span>LivePay Webhook / Instant Payment Notification (IPN)</span>
                  </h4>
                  <span className="text-[10px] text-slate-400">Endpoint: POST /api/payments/livepay/webhook</span>
                </div>

                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Register this callback URL in your LivePay Merchant Dashboard under Webhook / IPN Settings. When a customer completes a Mobile Money payment, LivePay POSTs here with an HMAC-SHA256 signature (X-Webhook-Signature) which the server verifies before marking the order as &ldquo;Paid&rdquo; and transitioning it to &ldquo;Processing&rdquo;. The endpoint acknowledges within the documented 10-second window and is idempotent under LivePay&rsquo;s 3 retry attempts.
                </p>

                <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200/80 dark:border-slate-700 flex items-center justify-between gap-3">
                  <span className="font-mono text-xs text-slate-800 dark:text-slate-200 truncate">
                    {typeof window !== "undefined" ? `${window.location.origin}/api/payments/livepay/webhook` : "https://drumpalace.ug/api/payments/livepay/webhook"}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyWebhookUrl}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-teal-600 text-white font-semibold text-xs hover:bg-teal-700 transition cursor-pointer shrink-0"
                  >
                    <Copy size={12} />
                    <span>{copiedWebhook ? "Copied!" : "Copy Webhook URL"}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ========================================================= */}
      {/* MODAL: PRODUCT CREATE / EDIT FORM */}
      {/* ========================================================= */}
      {editingProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl border border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-800 shadow-2xl flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                {isNewProduct ? "Add New Instrument to Catalog" : `Edit "${productForm.name}"`}
              </h3>
              <button
                onClick={() => setEditingProduct(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition"
              >
                <X size={16} />
              </button>
            </div>

            {/* Modal Scrollable Form */}
            <form onSubmit={handleSaveProductForm} className="flex-1 overflow-y-auto p-6 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Product Title</label>
                  <input
                    type="text"
                    required
                    value={productForm.name || ""}
                    onChange={(e) => setProductForm({ ...productForm, name: e.target.value })}
                    placeholder="e.g. Custom 5-Piece Maple Drum Shell Pack"
                    className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:border-teal-500 dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Category</label>
                  <select
                    value={productForm.category || "Drums"}
                    onChange={(e) => setProductForm({ ...productForm, category: e.target.value })}
                    className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                  >
                    <option value="Drums">Drums</option>
                    <option value="Guitars">Guitars</option>
                    <option value="Keyboards">Keyboards</option>
                    <option value="Mixers & Audio">Mixers & Audio</option>
                    <option value="Speakers">Speakers</option>
                    <option value="Stage Lighting">Stage Lighting</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Price ({currency})</label>
                  <input
                    type="number"
                    required
                    value={productForm.price || ""}
                    onChange={(e) => setProductForm({ ...productForm, price: Number(e.target.value) })}
                    placeholder="1500000"
                    className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:border-teal-500 dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Original / Compare Price ({currency})</label>
                  <input
                    type="number"
                    value={productForm.originalPrice || ""}
                    onChange={(e) => setProductForm({ ...productForm, originalPrice: Number(e.target.value) })}
                    placeholder="1850000"
                    className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:border-teal-500 dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                  />
                </div>
              </div>

              {/* Product Photo Upload to Supabase Storage 'products' bucket */}
              <div className="space-y-2 p-3.5 rounded-xl border border-teal-500/20 bg-teal-500/5 dark:bg-teal-950/10">
                <div className="flex items-center justify-between">
                  <label className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <ImageIcon size={14} className="text-teal-600 dark:text-teal-400" />
                    <span>Product Photo</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-teal-100 dark:bg-teal-900/50 text-teal-800 dark:text-teal-300 font-semibold">
                      Supabase Storage: products
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setIsManualUrlMode(!isManualUrlMode)}
                    className="text-[10px] text-slate-500 hover:text-teal-600 dark:text-slate-400 dark:hover:text-teal-400 underline font-medium cursor-pointer"
                  >
                    {isManualUrlMode ? "Hide URL Field" : "Paste URL Instead"}
                  </button>
                </div>

                {/* Live Image Preview & Dropzone */}
                <div className="space-y-2">
                  {productForm.image ? (
                    <div className="relative rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 flex items-center gap-3">
                      <div className="relative w-20 h-20 rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 shrink-0 border border-slate-200 dark:border-slate-700">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={productForm.image}
                          alt="Product preview"
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                          <span className="text-[11px] font-bold text-slate-900 dark:text-white truncate">
                            Photo Ready
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate">
                          {productForm.image.startsWith("data:") ? "Local preview image" : productForm.image}
                        </p>
                        <div className="flex items-center gap-2 pt-1">
                          <label className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-[10px] font-bold cursor-pointer transition shadow-xs">
                            <Upload size={11} />
                            <span>Replace Photo</span>
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              disabled={isUploadingProductImage}
                              onChange={(e) => {
                                if (e.target.files?.[0]) {
                                  handleProductImageFileUpload(e.target.files[0]);
                                }
                              }}
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() => setProductForm({ ...productForm, image: "" })}
                            className="px-2 py-1 rounded-lg text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 text-[10px] font-semibold cursor-pointer transition"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <label
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.dataTransfer.files?.[0]) {
                          handleProductImageFileUpload(e.dataTransfer.files[0]);
                        }
                      }}
                      className={`w-full flex flex-col items-center justify-center p-6 rounded-xl border-2 border-dashed transition cursor-pointer ${
                        isUploadingProductImage
                          ? "border-teal-500 bg-teal-50/50 dark:bg-teal-950/20"
                          : "border-slate-300 dark:border-slate-700 hover:border-teal-500 bg-white dark:bg-slate-900/60 hover:bg-teal-50/30 dark:hover:bg-teal-950/10"
                      }`}
                    >
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={isUploadingProductImage}
                        onChange={(e) => {
                          if (e.target.files?.[0]) {
                            handleProductImageFileUpload(e.target.files[0]);
                          }
                        }}
                      />
                      {isUploadingProductImage ? (
                        <div className="flex flex-col items-center gap-2 text-center">
                          <RefreshCw size={24} className="text-teal-600 dark:text-teal-400 animate-spin" />
                          <span className="font-bold text-teal-700 dark:text-teal-300 text-xs">
                            Uploading to Supabase Storage bucket &quot;products&quot;...
                          </span>
                          <span className="text-[10px] text-slate-500">Generating public link...</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-1.5 text-center">
                          <div className="w-10 h-10 rounded-full bg-teal-100 dark:bg-teal-900/40 text-teal-600 dark:text-teal-400 flex items-center justify-center mb-1">
                            <Upload size={18} />
                          </div>
                          <span className="font-bold text-slate-800 dark:text-slate-200 text-xs">
                            Click to upload photo or drag and drop
                          </span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400">
                            Uploads directly to your Supabase <span className="font-mono text-teal-600">products</span> bucket (JPG, PNG, WEBP up to 15MB)
                          </span>
                        </div>
                      )}
                    </label>
                  )}

                  {productImageUploadStatus && (
                    <div className="text-[10px] px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium flex items-center gap-1.5">
                      <CheckCircle2 size={11} className="text-teal-600 shrink-0" />
                      <span>{productImageUploadStatus}</span>
                    </div>
                  )}

                  {/* Manual URL Input Option */}
                  {isManualUrlMode && (
                    <div className="pt-2 border-t border-slate-200/60 dark:border-slate-700/60 space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">
                        Direct Image URL (Supabase or External CDN)
                      </label>
                      <input
                        type="text"
                        value={productForm.image || ""}
                        onChange={(e) => setProductForm({ ...productForm, image: e.target.value })}
                        placeholder="https://..."
                        className="w-full p-2 text-[11px] rounded-lg border border-slate-200 bg-white focus:bg-white focus:outline-none focus:border-teal-500 dark:bg-slate-800 dark:border-slate-700 dark:text-white font-mono"
                      />
                    </div>
                  )}

                  {/* Additional Images Section */}
                  <div className="pt-4 mt-4 border-t border-slate-200/60 dark:border-slate-700/60">
                    <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase block mb-2">
                      Additional Images Gallery
                    </label>
                    {productForm.images && productForm.images.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {productForm.images.map((img, idx) => (
                          <div key={idx} className="relative w-16 h-16 rounded-md overflow-hidden bg-slate-100 border border-slate-200 group">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={img} alt={`Gallery ${idx}`} className="w-full h-full object-cover" />
                            <button
                              type="button"
                              onClick={() => {
                                const newImgs = [...(productForm.images || [])];
                                newImgs.splice(idx, 1);
                                setProductForm({ ...productForm, images: newImgs });
                              }}
                              className="absolute inset-0 bg-black/50 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition cursor-pointer"
                            >
                              <span className="text-[10px] font-bold">Remove</span>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-semibold cursor-pointer transition">
                      <Upload size={12} className="text-teal-600" />
                      <span>{isUploadingProductImage ? "Uploading..." : "Add Gallery Image"}</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={isUploadingProductImage}
                        onChange={(e) => {
                          if (e.target.files?.[0]) {
                            handleAdditionalImageFileUpload(e.target.files[0]);
                          }
                        }}
                      />
                    </label>
                  </div>

                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Description & Acoustic Features</label>
                <textarea
                  rows={3}
                  value={productForm.description || ""}
                  onChange={(e) => setProductForm({ ...productForm, description: e.target.value })}
                  placeholder="Detailed acoustic build, wood materials, warranty, stage compatibility..."
                  className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:border-teal-500 dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Variants (Comma separated)</label>
                <input
                  type="text"
                  value={variantsString}
                  onChange={(e) => setVariantsString(e.target.value)}
                  placeholder="Natural Maple, Sunburst, Ebony Gloss"
                  className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none dark:bg-slate-800 dark:border-slate-700 dark:text-white font-medium"
                />
              </div>

              {/* Modal Actions */}
              <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingProduct(null)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-bold transition shadow-sm cursor-pointer"
                >
                  Save Product to Catalog
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
