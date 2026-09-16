/**
 * `FlashSaleStatus`, `VoucherType`, `PopupFrequency` — imported from
 * `apps/cms`, not hand-copied (issue #6, same discipline `katalog.ts`
 * already follows for the product-parity unions). Issue #26 (marketing
 * surface) is the first thing `apps/storefront` needs from `commerce`
 * outside the product/category catalog, so this is a new file rather than
 * growing `katalog.ts` past its own "product/category" scope.
 *
 * Re-exporting the TYPE beats hand-copying it for the same reason
 * `katalog.ts`'s header gives: when `apps/cms` widens one of these unions,
 * a hand-copied one stays green and the storefront silently mis-reads the
 * new value; re-exporting turns that widening into the storefront's own
 * compile error at its first exhaustive `switch`.
 *
 * ## What is NOT re-exported here, and why
 *
 * The read-model DTO SHAPES (`FlashSalePublicDTO`, `VoucherRecord`,
 * `SliderPublicDTO`, `TestimonialPublicDTO`, `PopupPublicDTO`,
 * `StoreSettingsPublicRecord`) stay out, same reasoning `katalog.ts` gives
 * for `CommerceProduct`/`CommerceCategory`: they live in `application/*.ts`,
 * which carries I/O-bearing imports (`Bun.SQL`, audit logging, domain
 * events) on other lines of the same file — `import type` does not execute
 * them, but `tsc` still parses the whole file to build its type graph, so
 * this package deliberately does not reach that layer. `apps/storefront`
 * keeps its own local, structural declarations of those shapes instead,
 * matching the contract document (`docs`'s commerce-public-read-models),
 * the same way it already does for `CommerceProduct`/`CommerceCategory`.
 *
 * `export type` only, no value — see `src/index.ts`'s docblock for why.
 */
export type { FlashSaleStatus } from "awcms/src/modules/commerce/domain/flash-sale-status";
export type { VoucherType } from "awcms/src/modules/commerce/domain/voucher-validation";
export type { PopupFrequency } from "awcms/src/modules/commerce/domain/popup-validation";
