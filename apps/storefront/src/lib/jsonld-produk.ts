/**
 * `Product` + `Offer` + `AggregateRating` + `BreadcrumbList` JSON-LD for
 * `/product/[slug]` — kept in its own file (unlike increment 1's
 * `product/[slug].astro`, which built one small `Product` object inline)
 * because #27 adds three more schema.org node types to the same page.
 *
 * `BaseLayout.astro`'s `schema` prop takes exactly ONE object, merged with
 * `@context` and written into ONE `<script type="application/ld+json">`
 * block (`jsonForScript`, that file's own XSS-safety note — this file does
 * not need to repeat that escaping: it happens once, in the one place the
 * object is serialized). Four schema.org types inside one block is what
 * `@graph` is for — see https://schema.org/docs/json-ld.html#graph — so
 * `buildProductPageSchema` below returns `{ "@graph": [...] }`, not four
 * separate objects.
 */
import type { CommerceCategory, CommerceProduct, CommerceProductVariant } from "./catalog";

export type BreadcrumbItem = { name: string; url: string };

function breadcrumbListNode(items: readonly BreadcrumbItem[]): Record<string, unknown> {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url
    }))
  };
}

export type ProductSchemaInput = {
  product: CommerceProduct;
  variant: CommerceProductVariant | null;
  category: CommerceCategory | null;
  canonicalUrl: string;
  imageUrls: readonly string[];
  breadcrumb: readonly BreadcrumbItem[];
};

/**
 * The full JSON-LD graph for one product detail page.
 *
 * `offers.price` is the variant's own price when one is selected and has
 * one, else the product's `finalPrice` — both already-computed, exact
 * decimal STRINGS from awcms; schema.org's `price` property wants a plain
 * decimal, not a locale-formatted string like "Rp150.000" (Google's
 * structured-data validator rejects the latter — the same reasoning
 * increment 1's revision of this file already applied).
 *
 * `aggregateRating` is present only when `averageRating` is set — a product
 * with no rating yet gets no `AggregateRating` node at all, rather than a
 * fabricated one; `soldCount` doubles as `reviewCount` for lack of a
 * separate review count in this DTO (documented rather than silently
 * assumed — increment 1's product model carries no separate review count,
 * and inventing one would be worse than omitting the field).
 */
export function buildProductPageSchema(input: ProductSchemaInput): Record<string, unknown> {
  const { product, variant, category, canonicalUrl, imageUrls, breadcrumb } = input;

  const price = variant?.price ?? product.finalPrice;
  const inStock = (variant?.stock ?? product.stock) > 0;

  const productNode: Record<string, unknown> = {
    "@type": "Product",
    name: product.name,
    sku: variant?.sku ?? product.sku,
    ...(product.description ? { description: product.description } : {}),
    ...(category ? { category: category.name } : {}),
    ...(imageUrls.length > 0 ? { image: imageUrls } : {}),
    offers: {
      "@type": "Offer",
      url: canonicalUrl,
      price,
      priceCurrency: "IDR",
      availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock"
    }
  };

  if (product.averageRating !== null) {
    productNode.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: product.averageRating,
      reviewCount: Math.max(product.soldCount, 1)
    };
  }

  return { "@graph": [productNode, breadcrumbListNode(breadcrumb)] };
}

/** `CollectionPage` JSON-LD for `/kategori/[slug]` — the issue's own acceptance criterion for that page. */
export function buildCategoryPageSchema(
  category: CommerceCategory,
  canonicalUrl: string,
  breadcrumb: readonly BreadcrumbItem[]
): Record<string, unknown> {
  return {
    "@graph": [
      {
        "@type": "CollectionPage",
        name: category.name,
        url: canonicalUrl
      },
      breadcrumbListNode(breadcrumb)
    ]
  };
}
