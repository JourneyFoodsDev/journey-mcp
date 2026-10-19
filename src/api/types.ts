import { z } from 'zod';

export const SupplierSchema = z.object({
  id: z.string(),
  name: z.string(),
  legal_name: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  categories: z.array(z.string()),
  certifications: z.array(z.string()),
  ingredients: z.array(z.string()),
  locations: z.array(z.string()),
  verification_status: z.string().nullable().optional(),
  domain_verified: z.boolean().nullable().optional(),
});
export type Supplier = z.infer<typeof SupplierSchema>;

export const IngredientSchema = z.object({
  id: z.string(),
  name: z.string(),
  image_url: z.string().nullable().optional(),
  nutrition_score: z.number().nullable().optional(),
  sustainability_score: z.number().nullable().optional(),
  nutrition_per_100g: z.record(z.number().nullable()).optional(),
  nutrients: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
  allergens: z.array(z.string()).optional(),
  allergens_by_country: z.array(z.string()).optional(),
  attributes: z.record(z.unknown()).optional(),
});
export type Ingredient = z.infer<typeof IngredientSchema>;

export const PricePointSchema = z.object({ date: z.string(), price: z.number() });
export const PriceSchema = z.object({
  series_id: z.string(),
  ingredient: z.string(),
  symbol: z.string(),
  unit: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  current: z.object({ price: z.number().nullable(), as_of: z.string().nullable().optional(), change_pct: z.number().nullable().optional() }),
  history: z.array(PricePointSchema),
  source: z.string().nullable().optional(),
  methodology_url: z.string().nullable().optional(),
});
export type Price = z.infer<typeof PriceSchema>;

export const LabResultSchema = z.object({
  verified: z.boolean(),
  result_id: z.string().nullable().optional(),
  subject: z.string(),
  subject_type: z.enum(['product', 'ingredient', 'supplier', 'company']).optional(),
  status: z.enum(['verified', 'revoked', 'none']).optional(),
  tested_at: z.string().nullable().optional(),
  lab: z.string().nullable().optional(),
  accreditation: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  verification_url: z.string().nullable().optional(),
  /** Short-lived link to the lab's PDF report. Paid tiers only. */
  pdf_url: z.string().nullable().optional(),
  pdf_available: z.boolean().optional(),
});
export type LabResult = z.infer<typeof LabResultSchema>;
export type LabSubjectType = 'product' | 'ingredient' | 'supplier' | 'company';
export interface LabLookupOptions {
  subjectType?: LabSubjectType;
  /** Paid tiers: include a short-lived PDF link when the result has one. */
  includePdf?: boolean;
}

export const IngredientSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  nutrition_score: z.number().nullable().optional(),
  sustainability_score: z.number().nullable().optional(),
});
export type IngredientSummary = z.infer<typeof IngredientSummarySchema>;

export const ForecastPointSchema = z.object({ date: z.string(), p10: z.number(), p50: z.number(), p90: z.number() });
export const PriceForecastSchema = z.object({
  published: z.boolean(),
  horizon_unit: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  beats_naive_by_pct: z.number().nullable().optional(),
  points: z.array(ForecastPointSchema),
});
export type PriceForecast = z.infer<typeof PriceForecastSchema>;

export const PriceSeriesSummarySchema = z.object({
  symbol: z.string(),
  name: z.string(),
  category: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
});
export type PriceSeriesSummary = z.infer<typeof PriceSeriesSummarySchema>;

export const ProductSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  sub_category: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
export type ProductSummary = z.infer<typeof ProductSummarySchema>;

export const ProductSchema = ProductSummarySchema.extend({
  ingredients: z.array(z.record(z.unknown())).optional(),
  nutrition: z.record(z.unknown()).nullable().optional(),
  nutrition_score: z.unknown().optional(),
  serving_size: z.unknown().optional(),
  serving_size_unit: z.string().nullable().optional(),
  attributes: z.record(z.unknown()).optional(),
});
export type Product = z.infer<typeof ProductSchema>;

export interface ProductQuery {
  query?: string;
  status?: 'active' | 'concept' | 'discontinued';
  page: number;
  limit: number;
}

export interface SupplierQuery {
  query?: string;
  ingredient?: string;
  category?: string;
  region?: string;
  certification?: string;
  limit: number;
  page?: number;
}

export interface Credential {
  apiKey?: string;
  /** Journey app session for the signed-in user. Only set by the remote OAuth server. Never logged. */
  appToken?: string;
}

/** Data adapter: the only layer that knows Journey's REST endpoints. Swap or extend it without touching tools. */
export interface JourneyData {
  searchSuppliers(q: SupplierQuery, cred: Credential): Promise<Supplier[]>;
  getSupplier(id: string, cred: Credential): Promise<Supplier | null>;
  searchIngredients(q: string, limit: number, cred: Credential): Promise<Ingredient[]>;
  getIngredient(id: string, cred: Credential): Promise<Ingredient | null>;
  getIngredientPrice(ingredient: string, days: number, cred: Credential): Promise<Price | null>;
  verifyLabResult(subject: string, resultId: string | undefined, cred: Credential, opts?: LabLookupOptions): Promise<LabResult>;
  listPriceSeries(cred: Credential): Promise<PriceSeriesSummary[]>;
  getPriceForecast(symbol: string, days: number, cred: Credential): Promise<PriceForecast | null>;
  /** The signed-in account's own products (Journey app API). Needs cred.appToken. */
  searchProducts(q: ProductQuery, cred: Credential): Promise<{ products: ProductSummary[]; total: number | null }>;
  getProduct(id: string, cred: Credential): Promise<Product | null>;
  /** Whether a backend is configured for this credential. Tools check it before counting anything. Missing = available. */
  available?(feature: 'ingredients' | 'labs' | 'products' | 'prices' | 'suppliers', cred: Credential): boolean;
}
