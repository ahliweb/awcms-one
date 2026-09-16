/**
 * `/product/[slug]` interactivity: variant picker, quantity stepper,
 * "Tambah ke keranjang", and the copy-link share action.
 *
 * The page's own data — everything the picker/stepper/add-to-cart need,
 * already resolved server-side — travels in ONE `data-produk-detail`
 * attribute on the root container (`product/[slug].astro`), as a JSON
 * string. This is a plain HTML ATTRIBUTE, not a `<script>` tag of any
 * `type` — reading it needs no CSP exemption and raises no "is this an
 * inline script" question at all, unlike a `<script type="application/
 * json">` data island would.
 *
 * Variant matching itself is `src/lib/catalog.ts`'s `findVariantForSelection`
 * — the SAME tested function `tests/katalog-catalog.test.ts` exercises —
 * never re-implemented here.
 */
import { findVariantForSelection, type CommerceProductVariant } from "../lib/catalog";
import { formatPrice } from "../lib/harga";
import { addToCart } from "../lib/keranjang-klien";

type ServiceFormFieldPayload = { id: string; label: string };

type FlashSalePayload = { id: string; salePrice: string; endsAt: string } | null;

type ProdukDetailPayload = {
  productId: string;
  slug: string;
  name: string;
  sku: string;
  finalPrice: string;
  minPurchase: number;
  weightGrams: number;
  stock: number;
  variants: CommerceProductVariant[];
  serviceFormFields: ServiceFormFieldPayload[];
  flashSale: FlashSalePayload;
  image: { url: string; alt: string } | null;
};

const root = document.querySelector<HTMLElement>("[data-produk-detail]");
if (root) {
  const raw = root.dataset.produkDetail;
  const payload: ProdukDetailPayload = raw
    ? (JSON.parse(raw) as ProdukDetailPayload)
    : {
        productId: "",
        slug: "",
        name: "",
        sku: "",
        finalPrice: "0",
        minPurchase: 1,
        weightGrams: 0,
        stock: 0,
        variants: [],
        serviceFormFields: [],
        flashSale: null,
        image: null
      };

  const groups = Array.from(
    root.querySelectorAll<HTMLFieldSetElement>("[data-variant-group]")
  ).sort((a, b) => Number(a.dataset.groupIndex ?? 0) - Number(b.dataset.groupIndex ?? 0));

  const priceEl = root.querySelector<HTMLElement>("[data-variant-price]");
  const stockEl = root.querySelector<HTMLElement>("[data-variant-stock]");
  const skuEl = root.querySelector<HTMLElement>("[data-variant-sku]");
  const qtyInput = root.querySelector<HTMLInputElement>("[data-qty-input]");
  const addButton = root.querySelector<HTMLButtonElement>("[data-add-to-cart]");
  const feedback = root.querySelector<HTMLElement>("[data-cart-feedback]");

  function selectedOptionNames(): string[] {
    return groups
      .map(
        (group) =>
          group.querySelector<HTMLInputElement>("[data-variant-option]:checked")?.value
      )
      .filter((value): value is string => Boolean(value));
  }

  function currentVariant(): CommerceProductVariant | null {
    const selection = selectedOptionNames();
    return findVariantForSelection(payload.variants, selection) ?? null;
  }

  function effectiveMaxQuantity(variant: CommerceProductVariant | null): number {
    return variant ? variant.stock : payload.stock;
  }

  function effectivePrice(variant: CommerceProductVariant | null): string {
    if (payload.flashSale) return payload.flashSale.salePrice;
    return variant?.price ?? payload.finalPrice;
  }

  function refresh(): void {
    const variant = currentVariant();
    const stock = effectiveMaxQuantity(variant);
    const inStock = stock > 0;

    if (priceEl) priceEl.textContent = formatPrice(effectivePrice(variant));
    if (skuEl) skuEl.textContent = `SKU: ${variant?.sku ?? payload.sku}`;
    if (stockEl) {
      stockEl.textContent = inStock ? "Stok tersedia" : "Stok habis";
      stockEl.classList.toggle("stock-badge--in", inStock);
      stockEl.classList.toggle("stock-badge--out", !inStock);
    }

    if (qtyInput) {
      qtyInput.min = String(payload.minPurchase);
      qtyInput.max = String(Math.max(stock, 0));
      const current = Number(qtyInput.value) || payload.minPurchase;
      qtyInput.value = String(Math.min(Math.max(current, payload.minPurchase), Math.max(stock, 0)));
      qtyInput.disabled = !inStock;
    }

    if (addButton) addButton.disabled = !inStock || groups.some((group) => !hasSelection(group));
  }

  function hasSelection(group: HTMLFieldSetElement): boolean {
    return group.querySelector<HTMLInputElement>("[data-variant-option]:checked") !== null;
  }

  for (const group of groups) {
    group.addEventListener("change", refresh);
  }

  const decrementButton = root.querySelector<HTMLButtonElement>("[data-qty-decrement]");
  const incrementButton = root.querySelector<HTMLButtonElement>("[data-qty-increment]");

  decrementButton?.addEventListener("click", () => {
    if (!qtyInput) return;
    const min = Number(qtyInput.min) || 1;
    qtyInput.value = String(Math.max(min, (Number(qtyInput.value) || min) - 1));
  });

  incrementButton?.addEventListener("click", () => {
    if (!qtyInput) return;
    const max = Number(qtyInput.max) || Infinity;
    qtyInput.value = String(Math.min(max, (Number(qtyInput.value) || 0) + 1));
  });

  addButton?.addEventListener("click", () => {
    const variant = currentVariant();
    const quantity = Number(qtyInput?.value) || payload.minPurchase;

    const serviceFormValues: Record<string, string> | null =
      payload.serviceFormFields.length > 0
        ? Object.fromEntries(
            payload.serviceFormFields.map((field) => {
              const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
                `[data-service-field="${field.id}"]`
              );
              return [field.id, el?.value ?? ""];
            })
          )
        : null;

    addToCart({
      productId: payload.productId,
      variantId: variant?.id ?? null,
      slug: payload.slug,
      name: payload.name,
      variantName: variant ? `${variant.name}${variant.value !== "Standard" ? ` / ${variant.value}` : ""}` : null,
      sku: variant?.sku ?? payload.sku,
      unitPrice: effectivePrice(variant),
      quantity,
      minPurchase: payload.minPurchase,
      maxQuantity: effectiveMaxQuantity(variant),
      weightGrams: variant?.weightGrams || payload.weightGrams,
      image: payload.image,
      serviceFormValues,
      flashSaleId: payload.flashSale?.id ?? null
    });

    if (feedback) {
      feedback.hidden = false;
      feedback.textContent = "Ditambahkan ke keranjang.";
    }
  });

  const copyButton = root.querySelector<HTMLButtonElement>("[data-copy-link]");
  copyButton?.addEventListener("click", async () => {
    const url = copyButton.dataset.shareUrl ?? window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      copyButton.textContent = "Tautan disalin";
      setTimeout(() => {
        copyButton.textContent = "Salin Tautan";
      }, 2000);
    } catch {
      // Clipboard API unavailable/denied — the share links above (WA/FB/X)
      // still work with no JS involved at all.
    }
  });

  refresh();
}
