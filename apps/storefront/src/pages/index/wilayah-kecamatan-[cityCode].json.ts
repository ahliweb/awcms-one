/**
 * `/index/wilayah-kecamatan-{cityCode}.json` — one file per regency/city
 * under a CONFIGURED province, each holding that regency's
 * districts/kecamatan — the checkout address step's third `<select>`. See
 * `src/lib/awcms/wilayah-checkout.ts`.
 *
 * The `Promise.all` below is deliberately still a plain fan-out over every
 * regency (56 with the default `PUBLIC_WILAYAH_PROVINSI`): it fans out
 * PROMISES, not requests. Every `getCheckoutDistricts` call funnels through
 * `wilayah-checkout.ts`'s single module-level limiter
 * (`MAX_IN_FLIGHT_REGION_REQUESTS`), so at most 6 `idn-regions/regions`
 * requests are in flight however many paths this enumerates — issue #71
 * reproduced 56 concurrent requests against the CMS's 40-deep `interactive`
 * admission and 16 `database.pool.rejected`, and a build that failed. Do not
 * move the bound here: a per-route helper is one a future route forgets.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import {
  getAllCheckoutRegencies,
  getCheckoutDistricts,
  type WilayahRegion
} from "../../lib/awcms/wilayah-checkout";

export const prerender = true;

export const getStaticPaths: GetStaticPaths = async () => {
  const regencies = await getAllCheckoutRegencies();

  return Promise.all(
    regencies.map(async (regency) => ({
      params: { cityCode: regency.code },
      props: { districts: await getCheckoutDistricts(regency.code) }
    }))
  );
};

export const GET: APIRoute = ({ props }) => {
  const districts = (props as { districts: WilayahRegion[] }).districts;

  return new Response(
    JSON.stringify(districts.map(({ code, name }) => ({ code, name }))),
    { headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
};
