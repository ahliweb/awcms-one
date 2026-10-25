/**
 * The "Notifikasi" card on `/akun` (issue #431). Present in the markup only in
 * a build with `PUBLIC_CUSTOMER_PUSH` on, and `hidden` until the CMS says the
 * capability exists: the neutral 404 (the tenant's `customerPush` flag off), a
 * malformed answer, a failed request and a server that is enabled=false all
 * leave the card hidden - the control is simply not there. It never asks for a
 * permission, never touches the Push API and never subscribes; the settings
 * page does that, from a click.
 */
import { ambilStatusPush } from "../lib/akun-klien";
import { bacaSesi } from "../lib/akun-sesi";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";
import { parseStatus } from "../lib/push-pelanggan";

const kartu = document.querySelector<HTMLElement>("[data-notif-kartu]");
const ringkasan = kartu?.querySelector<HTMLElement>("[data-notif-kartu-ringkasan]");

async function perbarui(): Promise<void> {
  if (!kartu) return;
  if (!bacaSesi()) {
    kartu.hidden = true;
    return;
  }

  try {
    const status = parseStatus(await ambilStatusPush());
    if (!status || !status.capability.enabled) {
      kartu.hidden = true;
      return;
    }
    const jumlah = status.devices.length;
    if (ringkasan) {
      ringkasan.textContent =
        jumlah > 0
          ? `Notifikasi aktif di ${jumlah} perangkat. Atur jenis notifikasi dan perangkat Anda.`
          : "Dapatkan kabar pesanan dan pembayaran di perangkat ini.";
    }
    kartu.hidden = false;
  } catch {
    // 404 (flag off), 401 (session gone), network: the card stays hidden.
    kartu.hidden = true;
  }
}

if (kartu) {
  void perbarui();
  window.addEventListener(AKUN_EVENT_NAME, () => void perbarui());
}
