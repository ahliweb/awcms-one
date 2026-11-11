/**
 * The real ports for `push-alur.ts` (issue #431): the account client, the
 * stored session, the browser's push stack. Kept apart from `push-alur.ts` so
 * the flows stay importable by a unit test with no browser, and so a page that
 * only needs the sign-out path imports this one file and nothing else.
 *
 * Browser-only: never import it from `.astro` frontmatter.
 */
import { cabutPerangkatPush, daftarkanPerangkatPush, keluar } from "./akun-klien";
import { bacaSesi, hapusSesi } from "./akun-sesi";
import {
  buatPortPemberitahuan,
  buatPortPenanda,
  buatPortPeramban,
  type DepsPush
} from "./push-alur";

export function buatDepsNyata(): DepsPush {
  return {
    browser: buatPortPeramban(),
    server: {
      daftar: (input) => daftarkanPerangkatPush(input),
      cabut: (id) => cabutPerangkatPush(id),
      keluar: () => keluar()
    },
    sesi: {
      akunId: () => bacaSesi()?.account.id ?? null,
      hapus: () => hapusSesi()
    },
    penanda: buatPortPenanda(),
    pemberitahuan: buatPortPemberitahuan()
  };
}
