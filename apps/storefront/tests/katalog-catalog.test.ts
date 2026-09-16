import { describe, expect, test } from "bun:test";
import {
  buildCategoryTree,
  buildPriceTiers,
  buildProdukIndex,
  collectCategorySubtreeIds,
  filterProdukIndex,
  findVariantForSelection,
  getCategoryBySlug,
  labelClassName,
  paginateProdukIndex,
  primaryProductImage,
  productsInCategory,
  type CommerceCategory,
  type CommerceProduct,
  type CommerceProductVariant,
  type ProdukIndexEntry
} from "../src/lib/catalog";

function category(overrides: Partial<CommerceCategory>): CommerceCategory {
  return {
    id: "cat-1",
    parentId: null,
    name: "Category",
    slug: "category",
    icon: null,
    productCount: 0,
    ...overrides
  };
}

function product(overrides: Partial<CommerceProduct>): CommerceProduct {
  return {
    id: "prod-1",
    categoryId: null,
    type: "physical",
    sku: "SKU-1",
    name: "Product",
    slug: "product",
    description: null,
    digitalNote: null,
    price: "10000.00",
    discountPercent: 0,
    stock: 10,
    status: "active",
    label: null,
    labelColor: null,
    priceLevel2: null,
    priceLevel3: null,
    priceLevel4: null,
    minPurchase: 1,
    weightGrams: 100,
    manualRating: null,
    manualSoldCount: 0,
    withInsurance: false,
    insuranceRequired: false,
    insuranceFee: null,
    promoBannerShow: false,
    promoBannerTitle: null,
    promoBannerSubtitle: null,
    promoBannerBadge: null,
    promoBannerIcon: null,
    promoBannerColor: null,
    sizeChartType: "none",
    sizeChartMediaId: null,
    sizeChartDetails: null,
    serviceForm: null,
    subscriptionPeriod: null,
    downloadLink: null,
    allowDp: false,
    allowFreeShipping: false,
    variantAttributes: null,
    isFeatured: false,
    isRecommended: false,
    finalPrice: "10000.00",
    averageRating: null,
    soldCount: 0,
    images: [],
    variants: [],
    ...overrides
  };
}

function variant(overrides: Partial<CommerceProductVariant>): CommerceProductVariant {
  return {
    id: "var-1",
    productId: "prod-1",
    name: "Option",
    value: "Standard",
    colorHex: null,
    imageMediaObjectId: null,
    imageUrl: null,
    sku: null,
    price: null,
    priceLevel2: null,
    priceLevel3: null,
    priceLevel4: null,
    stock: 5,
    weightGrams: 0,
    sortOrder: 1,
    ...overrides
  };
}

describe("catalog: buildCategoryTree", () => {
  test("nests children under their parent, in a forest of roots", () => {
    const categories = [
      category({ id: "a", name: "A" }),
      category({ id: "b", name: "B" }),
      category({ id: "a1", parentId: "a", name: "A1" }),
      category({ id: "a2", parentId: "a", name: "A2" })
    ];

    const tree = buildCategoryTree(categories);

    expect(tree.map((node) => node.id)).toEqual(["a", "b"]);
    const nodeA = tree.find((node) => node.id === "a");
    expect(nodeA?.children.map((child) => child.id)).toEqual(["a1", "a2"]);
  });

  test("a dangling parentId (soft-deleted/absent parent) degrades to its own root", () => {
    const categories = [category({ id: "orphan", parentId: "missing", name: "Orphan" })];
    const tree = buildCategoryTree(categories);
    expect(tree.map((node) => node.id)).toEqual(["orphan"]);
  });
});

describe("catalog: collectCategorySubtreeIds", () => {
  test("includes the root and every descendant, at any depth", () => {
    const categories = [
      category({ id: "a" }),
      category({ id: "a1", parentId: "a" }),
      category({ id: "a1x", parentId: "a1" }),
      category({ id: "b" })
    ];

    const ids = collectCategorySubtreeIds(categories, "a");
    expect([...ids].sort()).toEqual(["a", "a1", "a1x"]);
  });

  test("a leaf category's subtree is only itself", () => {
    const categories = [category({ id: "a" }), category({ id: "a1", parentId: "a" })];
    expect([...collectCategorySubtreeIds(categories, "a1")]).toEqual(["a1"]);
  });
});

describe("catalog: productsInCategory", () => {
  test("keeps only products whose categoryId is in the given set", () => {
    const products = [
      product({ id: "p1", categoryId: "a" }),
      product({ id: "p2", categoryId: "b" }),
      product({ id: "p3", categoryId: null })
    ];

    const result = productsInCategory(products, new Set(["a"]));
    expect(result.map((p) => p.id)).toEqual(["p1"]);
  });
});

describe("catalog: getCategoryBySlug", () => {
  test("finds by slug, or returns undefined", () => {
    const categories = [category({ id: "a", slug: "kopi" })];
    expect(getCategoryBySlug(categories, "kopi")?.id).toBe("a");
    expect(getCategoryBySlug(categories, "teh")).toBeUndefined();
  });
});

describe("catalog: findVariantForSelection", () => {
  test("matches a single-group product by option name landing in variant.name (the real BjekMart shape)", () => {
    const variants = [variant({ id: "v1", name: "Original" }), variant({ id: "v2", name: "Pedas" })];
    expect(findVariantForSelection(variants, ["Pedas"])?.id).toBe("v2");
  });

  test("matches a two-group product by name AND value", () => {
    const variants = [
      variant({ id: "v1", name: "M", value: "Merah" }),
      variant({ id: "v1b", name: "M", value: "Biru" })
    ];
    expect(findVariantForSelection(variants, ["M", "Biru"])?.id).toBe("v1b");
  });

  test("no selection yields undefined, never the first variant by default", () => {
    expect(findVariantForSelection([variant({})], [])).toBeUndefined();
  });

  test("an unmatched selection yields undefined", () => {
    expect(findVariantForSelection([variant({ name: "Original" })], ["Extra Pedas"])).toBeUndefined();
  });
});

describe("catalog: primaryProductImage", () => {
  test("the first image with a resolvable publicUrl", () => {
    const p = product({
      images: [
        { id: "i1", productId: "prod-1", mediaObjectId: "m1", publicUrl: null, altText: null, sortOrder: 1 },
        { id: "i2", productId: "prod-1", mediaObjectId: "m2", publicUrl: "https://x/y.jpg", altText: "Alt", sortOrder: 2 }
      ]
    });
    expect(primaryProductImage(p)).toEqual({ url: "https://x/y.jpg", alt: "Alt" });
  });

  test("null when no image resolves, or the product has none", () => {
    expect(primaryProductImage(product({ images: [] }))).toBeNull();
  });

  test("falls back to the product name for a missing alt text", () => {
    const p = product({
      name: "Kopi",
      images: [{ id: "i1", productId: "prod-1", mediaObjectId: "m1", publicUrl: "https://x/y.jpg", altText: null, sortOrder: 1 }]
    });
    expect(primaryProductImage(p)?.alt).toBe("Kopi");
  });
});

describe("catalog: buildPriceTiers", () => {
  test("level 1 is always present; higher tiers only when set", () => {
    const p = product({ finalPrice: "9000.00", priceLevel2: "8500.00", priceLevel3: null, priceLevel4: null });
    const tiers = buildPriceTiers(p, null, []);
    expect(tiers.map((t) => t.level)).toEqual([1, 2]);
    expect(tiers[0]?.price).toBe("9000.00");
    expect(tiers[1]?.price).toBe("8500.00");
  });

  test("uses a configured customer level name when present, a generic fallback otherwise", () => {
    const p = product({ priceLevel2: "8500.00" });
    const withNames = buildPriceTiers(p, null, [{ level: 2, name: "Reseller" }]);
    expect(withNames[1]?.label).toBe("Reseller");

    const withoutNames = buildPriceTiers(p, null, []);
    expect(withoutNames[1]?.label).toBe("Harga Level 2");
  });

  test("a selected variant's own price/tiers override the product's", () => {
    const p = product({ finalPrice: "9000.00", priceLevel2: "8500.00" });
    const v = variant({ price: "7000.00", priceLevel2: "6500.00" });
    const tiers = buildPriceTiers(p, v, []);
    expect(tiers[0]?.price).toBe("7000.00");
    expect(tiers[1]?.price).toBe("6500.00");
  });
});

describe("catalog: search/listing index", () => {
  const products = [
    product({ id: "p1", slug: "kopi-arabika", name: "Kopi Arabika", sku: "KOPI-1", categoryId: "a", price: "10000.00", finalPrice: "9000.00", stock: 5 }),
    product({ id: "p2", slug: "teh-hitam", name: "Teh Hitam", sku: "TEH-1", categoryId: "b", price: "5000.00", finalPrice: "5000.00", stock: 0 })
  ];
  const categoriesById = new Map<string, CommerceCategory>([
    ["a", category({ id: "a", name: "Kopi", slug: "kopi" })],
    ["b", category({ id: "b", name: "Teh", slug: "teh" })]
  ]);

  test("buildProdukIndex carries category name/slug and flash-sale membership through", () => {
    const index = buildProdukIndex(products, categoriesById, new Set(["p1"]));
    expect(index).toHaveLength(2);
    expect(index[0]).toMatchObject({ id: "p1", categorySlug: "kopi", categoryName: "Kopi", inFlashSale: true });
    expect(index[1]).toMatchObject({ id: "p2", categorySlug: "teh", inFlashSale: false });
  });

  const index: ProdukIndexEntry[] = buildProdukIndex(products, categoriesById, new Set());

  test("filterProdukIndex: q matches name or sku, case-insensitively", () => {
    expect(filterProdukIndex(index, { q: "kopi" }).map((i) => i.id)).toEqual(["p1"]);
    expect(filterProdukIndex(index, { q: "TEH-1" }).map((i) => i.id)).toEqual(["p2"]);
    expect(filterProdukIndex(index, { q: "nonexistent" })).toEqual([]);
  });

  test("filterProdukIndex: categorySlug", () => {
    expect(filterProdukIndex(index, { categorySlug: "teh" }).map((i) => i.id)).toEqual(["p2"]);
  });

  test("filterProdukIndex: inStockOnly", () => {
    expect(filterProdukIndex(index, { inStockOnly: true }).map((i) => i.id)).toEqual(["p1"]);
  });

  test("filterProdukIndex: price range", () => {
    expect(filterProdukIndex(index, { minPrice: 6000 }).map((i) => i.id)).toEqual(["p1"]);
    expect(filterProdukIndex(index, { maxPrice: 6000 }).map((i) => i.id)).toEqual(["p2"]);
  });

  test("filterProdukIndex: sort price_asc/price_desc/name", () => {
    expect(filterProdukIndex(index, { sort: "price_asc" }).map((i) => i.id)).toEqual(["p2", "p1"]);
    expect(filterProdukIndex(index, { sort: "price_desc" }).map((i) => i.id)).toEqual(["p1", "p2"]);
    expect(filterProdukIndex(index, { sort: "name" }).map((i) => i.id)).toEqual(["p1", "p2"]);
  });

  test("paginateProdukIndex clamps an out-of-range page into range rather than returning empty", () => {
    const page = paginateProdukIndex(index, 99, 1);
    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(2);
    expect(page.items).toHaveLength(1);
  });

  test("paginateProdukIndex: an empty list is one page, page 1", () => {
    const page = paginateProdukIndex([], 1);
    expect(page).toEqual({ items: [], page: 1, totalPages: 1, totalItems: 0 });
  });
});

describe("catalog: labelClassName (unchanged contract product-labels.css.ts depends on)", () => {
  test("a valid hex color yields a deterministic class name", () => {
    expect(labelClassName("#1A2B3C")).toBe("label-bg-1a2b3c");
  });

  test("no color, or an invalid one, yields undefined", () => {
    expect(labelClassName(null)).toBeUndefined();
    expect(labelClassName(undefined)).toBeUndefined();
    expect(labelClassName("not-a-color")).toBeUndefined();
  });
});
