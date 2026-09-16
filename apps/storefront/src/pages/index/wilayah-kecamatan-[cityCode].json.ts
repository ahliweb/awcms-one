/**
 * `/index/wilayah-kecamatan-{cityCode}.json` — one file per regency/city
 * under a CONFIGURED province, each holding that regency's
 * districts/kecamatan — the checkout address step's third `<select>`. See
 * `src/lib/awcms/wilayah-checkout.ts`.
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
