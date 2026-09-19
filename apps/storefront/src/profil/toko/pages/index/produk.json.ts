/**
 * `/index/produk.json` — the build-time search/listing index `/produk` and
 * `/cari` both fetch client-side (same pattern issue #28 already used for
 * `/index/berita.json`): one small `ProdukIndexEntry` per active product —
 * id, slug, name, sku, category, price, finalPrice, image, label, rating,
 * sold, stock, inFlashSale — never the full `CommerceProduct` (that stays
 * behind `/product/{slug}`, this index is not a second copy of it).
 */
import { getProducts, getCategories, buildProdukIndex } from "../../../../lib/catalog";
import { getActiveFlashSales } from "../../../../lib/awcms/pemasaran";

export const prerender = true;

export async function GET(): Promise<Response> {
  const [products, categories, flashSales] = await Promise.all([
    getProducts(),
    getCategories(),
    getActiveFlashSales()
  ]);

  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const flashSaleProductIds = new Set(
    flashSales
      .filter((sale) => sale.status === "active")
      .flatMap((sale) => sale.products.map((entry) => entry.productId))
  );

  const index = buildProdukIndex(products, categoriesById, flashSaleProductIds);

  return new Response(JSON.stringify(index), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
