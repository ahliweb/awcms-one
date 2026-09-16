import { describe, expect, test } from "bun:test";
import { buildCategoryPageSchema, buildProductPageSchema } from "../src/lib/jsonld-produk";
import type { CommerceCategory, CommerceProduct } from "../src/lib/catalog";

function product(overrides: Partial<CommerceProduct> = {}): CommerceProduct {
  return {
    id: "p1",
    categoryId: null,
    type: "physical",
    sku: "SKU-1",
    name: "Kopi Arabika",
    slug: "kopi-arabika",
    description: "Kopi pilihan",
    digitalNote: null,
    price: "10000.00",
    discountPercent: 0,
    stock: 5,
    status: "active",
    label: null,
    labelColor: null,
    priceLevel2: null,
    priceLevel3: null,
    priceLevel4: null,
    minPurchase: 1,
    weightGrams: 250,
    manualRating: "4.8",
    manualSoldCount: 12,
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
    averageRating: "4.8",
    soldCount: 12,
    images: [],
    variants: [],
    ...overrides
  };
}

function category(overrides: Partial<CommerceCategory> = {}): CommerceCategory {
  return { id: "c1", parentId: null, name: "Kopi", slug: "kopi", icon: null, productCount: 3, ...overrides };
}

describe("jsonld-produk: buildProductPageSchema", () => {
  test("builds a @graph with a Product node (Offer nested) and a BreadcrumbList node", () => {
    const schema = buildProductPageSchema({
      product: product(),
      variant: null,
      category: category(),
      canonicalUrl: "https://mart.example/product/kopi-arabika",
      imageUrls: ["https://cms.example/kopi.jpg"],
      breadcrumb: [
        { name: "Beranda", url: "https://mart.example/" },
        { name: "Kopi Arabika", url: "https://mart.example/product/kopi-arabika" }
      ]
    });

    const graph = schema["@graph"] as Record<string, unknown>[];
    expect(graph).toHaveLength(2);

    const productNode = graph[0] as Record<string, unknown>;
    expect(productNode["@type"]).toBe("Product");
    expect(productNode.name).toBe("Kopi Arabika");
    expect(productNode.category).toBe("Kopi");
    expect(productNode.image).toEqual(["https://cms.example/kopi.jpg"]);

    const offer = productNode.offers as Record<string, unknown>;
    expect(offer["@type"]).toBe("Offer");
    expect(offer.price).toBe("10000.00");
    expect(offer.priceCurrency).toBe("IDR");
    expect(offer.availability).toBe("https://schema.org/InStock");

    const breadcrumbNode = graph[1] as Record<string, unknown>;
    expect(breadcrumbNode["@type"]).toBe("BreadcrumbList");
  });

  test("an out-of-stock product (or variant) reports OutOfStock availability", () => {
    const schema = buildProductPageSchema({
      product: product({ stock: 0 }),
      variant: null,
      category: null,
      canonicalUrl: "https://mart.example/product/kopi-arabika",
      imageUrls: [],
      breadcrumb: []
    });

    const productNode = (schema["@graph"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const offer = productNode.offers as Record<string, unknown>;
    expect(offer.availability).toBe("https://schema.org/OutOfStock");
  });

  test("no averageRating means no aggregateRating node at all — never a fabricated one", () => {
    const schema = buildProductPageSchema({
      product: product({ averageRating: null }),
      variant: null,
      category: null,
      canonicalUrl: "https://mart.example/product/kopi-arabika",
      imageUrls: [],
      breadcrumb: []
    });

    const productNode = (schema["@graph"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(productNode.aggregateRating).toBeUndefined();
  });

  test("a selected variant's own price overrides the product's finalPrice in the Offer", () => {
    const schema = buildProductPageSchema({
      product: product(),
      variant: {
        id: "v1",
        productId: "p1",
        name: "Besar",
        value: "Standard",
        colorHex: null,
        imageMediaObjectId: null,
        imageUrl: null,
        sku: "SKU-1-B",
        price: "15000.00",
        priceLevel2: null,
        priceLevel3: null,
        priceLevel4: null,
        stock: 3,
        weightGrams: 500,
        sortOrder: 1
      },
      category: null,
      canonicalUrl: "https://mart.example/product/kopi-arabika",
      imageUrls: [],
      breadcrumb: []
    });

    const productNode = (schema["@graph"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(productNode.sku).toBe("SKU-1-B");
    expect((productNode.offers as Record<string, unknown>).price).toBe("15000.00");
  });
});

describe("jsonld-produk: buildCategoryPageSchema", () => {
  test("builds a @graph with a CollectionPage node and a BreadcrumbList node", () => {
    const schema = buildCategoryPageSchema(category(), "https://mart.example/kategori/kopi", [
      { name: "Beranda", url: "https://mart.example/" },
      { name: "Kopi", url: "https://mart.example/kategori/kopi" }
    ]);

    const graph = schema["@graph"] as Record<string, unknown>[];
    expect(graph[0]).toMatchObject({ "@type": "CollectionPage", name: "Kopi", url: "https://mart.example/kategori/kopi" });
    expect(graph[1]).toMatchObject({ "@type": "BreadcrumbList" });
  });
});
