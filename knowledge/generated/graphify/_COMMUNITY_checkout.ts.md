---
type: community
cohesion: 0.17
members: 17
---

# checkout.ts

**Cohesion:** 0.17 - loosely connected
**Members:** 17 nodes

## Members
- [[dot-freshQuote()]] - code - apps/storefront/src/lib/toko-permintaan.ts
- [[ADR-0007_11]] - concept - apps/storefront/src/scripts/checkout.ts
- [[Alamat]] - code - apps/storefront/src/lib/akun-klien.ts
- [[CartLineRequest]] - code - apps/storefront/src/lib/toko-klien.ts
- [[CartQuote]] - code - apps/storefront/src/lib/toko-klien.ts
- [[STEP_ORDER]] - code - apps/storefront/src/scripts/checkout.ts
- [[ShippingSelection]] - code - apps/storefront/src/lib/toko-klien.ts
- [[Step]] - code - apps/storefront/src/scripts/checkout.ts
- [[checkout.ts]] - code - apps/storefront/src/scripts/checkout.ts
- [[createOrder()]] - code - apps/storefront/src/lib/toko-klien.ts
- [[keepDigitsAndLeadingPlus()]] - code - apps/storefront/src/lib/telepon.ts
- [[previewIndonesianPhone()]] - code - apps/storefront/src/lib/telepon.ts
- [[root_10]] - code - apps/storefront/src/scripts/checkout.ts
- [[runCheckout()]] - code - apps/storefront/src/scripts/checkout.ts
- [[telepon.test.ts]] - code - apps/storefront/tests/telepon.test.ts
- [[telepon.ts]] - code - apps/storefront/src/lib/telepon.ts
- [[toLineRequests()_1]] - code - apps/storefront/src/scripts/checkout.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/checkoutts
SORT file.name ASC
```

## Connections to other communities
- 9 edges to [[_COMMUNITY_toko-klien.ts]]
- 7 edges to [[_COMMUNITY_formatPrice]]
- 5 edges to [[_COMMUNITY_keranjang-kontrak.ts]]
- 5 edges to [[_COMMUNITY_akun-klien.ts]]
- 5 edges to [[_COMMUNITY_wilayah-region-select.ts]]
- 3 edges to [[_COMMUNITY_afiliasi-kontrak.ts]]
- 3 edges to [[_COMMUNITY_bacaSesi]]
- 3 edges to [[_COMMUNITY_masuk.ts]]
- 1 edge to [[_COMMUNITY_harga.ts]]
- 1 edge to [[_COMMUNITY_akun-alamat.ts]]
- 1 edge to [[_COMMUNITY_akun-pesanan.ts]]
- 1 edge to [[_COMMUNITY_profil.ts]]

## Top bridge nodes
- [[checkout.ts]] - degree 39, connects to 11 communities
- [[runCheckout()]] - degree 11, connects to 5 communities
- [[CartQuote]] - degree 5, connects to 3 communities
- [[createOrder()]] - degree 5, connects to 2 communities
- [[Alamat]] - degree 3, connects to 2 communities