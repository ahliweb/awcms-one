/**
 * `/index/wilayah-provinsi.json` — every province the checkout address step
 * may offer (`PUBLIC_WILAYAH_PROVINSI`, default: every Kalimantan province),
 * fetched at BUILD time — see `src/lib/awcms/wilayah-checkout.ts`'s own
 * header for why this is a separate mechanism from `wilayah.ts`
 * (issue #28's news regions).
 */
import { getCheckoutProvinces } from "../../../../lib/awcms/wilayah-checkout";

export const prerender = true;

export async function GET(): Promise<Response> {
  const provinces = await getCheckoutProvinces();

  return new Response(
    JSON.stringify(provinces.map(({ code, name }) => ({ code, name }))),
    { headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
}
