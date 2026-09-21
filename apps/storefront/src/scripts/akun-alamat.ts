/**
 * `/akun/alamat` interactivity (issue #90) — list/add/edit/delete/set-default
 * over `akun-klien.ts`'s address functions. The province/city/district
 * selects are wired through `wilayah-region-select.ts`, the SAME shared
 * module `checkout.ts`'s own saved-address autofill uses — this file does
 * not re-implement the cascading-fetch logic.
 *
 * Max 10 addresses (#86's own limit) is enforced HERE, client-side, before
 * ever sending a create request — a clear inline message replaces the "Tambah
 * alamat baru" button once the account already has 10, rather than letting a
 * shopper fill the whole form only to be told no by a `400` at the end.
 */
import {
  ambilAlamat,
  hapusAlamat,
  jadikanAlamatUtama,
  tambahAlamat,
  ubahAlamat,
  type Alamat,
  type AlamatInput
} from "../lib/akun-klien";
import { bacaSesi } from "../lib/akun-sesi";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";
import { TokoApiError } from "../lib/toko-permintaan";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";
import { applyRegionSelection, wireCascadingRegionSelects } from "../lib/wilayah-region-select";

const MAX_ALAMAT = 10;

const root = document.querySelector<HTMLElement>("[data-akun-alamat-root]");
if (root) {
  const guestView = root.querySelector<HTMLElement>("[data-guest-view]");
  const accountView = root.querySelector<HTMLElement>("[data-account-view]");
  const statusEl = root.querySelector<HTMLElement>("[data-status]");
  const submitErrorEl = root.querySelector<HTMLElement>("[data-submit-error]");
  const submitErrorMessageEl = root.querySelector<HTMLElement>("[data-submit-error-message]");
  const waFallbackLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]");

  const listEl = root.querySelector<HTMLElement>("[data-alamat-list]");
  const listEmptyEl = root.querySelector<HTMLElement>("[data-alamat-empty]");
  const limitMessageEl = root.querySelector<HTMLElement>("[data-alamat-limit]");
  const addButton = root.querySelector<HTMLButtonElement>("[data-alamat-tambah]");

  const formWrap = root.querySelector<HTMLElement>("[data-alamat-form-wrap]");
  const form = root.querySelector<HTMLFormElement>("[data-alamat-form]");
  const formTitle = root.querySelector<HTMLElement>("[data-alamat-form-title]");
  const cancelFormButton = root.querySelector<HTMLButtonElement>("[data-alamat-form-cancel]");

  const provinceSelect = form?.querySelector<HTMLSelectElement>("[data-province-select]") ?? null;
  const citySelect = form?.querySelector<HTMLSelectElement>("[data-city-select]") ?? null;
  const districtSelect = form?.querySelector<HTMLSelectElement>("[data-district-select]") ?? null;

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";

  let alamatList: Alamat[] = [];
  let editingId: string | null = null;

  if (provinceSelect && citySelect && districtSelect) {
    wireCascadingRegionSelects({ province: provinceSelect, city: citySelect, district: districtSelect });
  }

  function hideSubmitError(): void {
    if (submitErrorEl) submitErrorEl.hidden = true;
    if (waFallbackLink) waFallbackLink.hidden = true;
  }

  function showSubmitError(error: unknown, context: string): void {
    if (submitErrorEl && submitErrorMessageEl) {
      submitErrorEl.hidden = false;
      submitErrorMessageEl.textContent =
        error instanceof TokoApiError ? error.message : "Terjadi kesalahan yang tidak terduga.";
    }
    if (waFallbackLink && whatsappNumber) {
      waFallbackLink.href = buildWhatsappUrl(whatsappNumber, buildWhatsappAccountMessage(storeName, context));
      waFallbackLink.hidden = false;
    }
  }

  function showGuestView(): void {
    if (guestView) guestView.hidden = false;
    if (accountView) accountView.hidden = true;
  }

  function clearFieldErrors(): void {
    form?.querySelectorAll<HTMLElement>("[data-error-for]").forEach((el) => {
      el.textContent = "";
    });
  }

  function closeForm(): void {
    if (formWrap) formWrap.hidden = true;
    editingId = null;
    form?.reset();
    clearFieldErrors();
  }

  function openFormForCreate(): void {
    if (alamatList.length >= MAX_ALAMAT) return;
    editingId = null;
    if (formTitle) formTitle.textContent = "Tambah Alamat";
    form?.reset();
    clearFieldErrors();
    if (formWrap) formWrap.hidden = false;
  }

  async function openFormForEdit(alamat: Alamat): Promise<void> {
    editingId = alamat.id;
    if (formTitle) formTitle.textContent = "Ubah Alamat";
    clearFieldErrors();
    if (formWrap) formWrap.hidden = false;

    const setValue = (name: string, value: string): void => {
      const el = form?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
      if (el) el.value = value;
    };

    setValue("label", alamat.label);
    setValue("recipientName", alamat.recipientName);
    setValue("phone", alamat.phone);
    setValue("postalCode", alamat.postalCode);
    setValue("street", alamat.street);
    setValue("notes", alamat.notes ?? "");

    const isDefaultInput = form?.querySelector<HTMLInputElement>('[name="isDefault"]');
    if (isDefaultInput) isDefaultInput.checked = alamat.isDefault;

    if (provinceSelect && citySelect && districtSelect) {
      await applyRegionSelection(
        { province: provinceSelect, city: citySelect, district: districtSelect },
        { provinceCode: alamat.provinceCode, cityCode: alamat.cityCode, districtCode: alamat.districtCode }
      );
    }
  }

  function renderList(): void {
    if (!listEl) return;
    listEl.innerHTML = "";

    if (listEmptyEl) listEmptyEl.hidden = alamatList.length > 0;

    for (const alamat of alamatList) {
      const li = document.createElement("li");
      li.className = "akun-card akun-address-card";

      const heading = document.createElement("p");
      heading.className = "akun-address-heading";
      const strong = document.createElement("span");
      strong.className = "akun-address-name";
      strong.textContent = alamat.label;
      heading.appendChild(strong);
      if (alamat.isDefault) {
        const badge = document.createElement("span");
        badge.className = "pill pill--success";
        badge.textContent = "Utama";
        heading.appendChild(badge);
      }
      li.appendChild(heading);

      const detail = document.createElement("p");
      detail.className = "akun-address-body";
      detail.textContent = `${alamat.recipientName} — ${alamat.phone}`;
      li.appendChild(detail);

      const region = document.createElement("p");
      region.className = "akun-address-body";
      region.textContent = `${alamat.street}, ${alamat.districtName}, ${alamat.cityName}, ${alamat.provinceName} ${alamat.postalCode}`;
      li.appendChild(region);

      const actions = document.createElement("div");
      actions.className = "akun-actions";

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "btn btn--secondary btn--sm";
      editButton.textContent = "Ubah";
      editButton.addEventListener("click", () => void openFormForEdit(alamat));
      actions.appendChild(editButton);

      if (!alamat.isDefault) {
        const defaultButton = document.createElement("button");
        defaultButton.type = "button";
        defaultButton.className = "btn btn--secondary btn--sm";
        defaultButton.textContent = "Jadikan Utama";
        defaultButton.addEventListener("click", () => void setDefault(alamat.id));
        actions.appendChild(defaultButton);
      }

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "btn btn--quiet btn--sm akun-btn-danger";
      deleteButton.textContent = "Hapus";
      deleteButton.addEventListener("click", () => void deleteAlamat(alamat.id));
      actions.appendChild(deleteButton);

      li.appendChild(actions);
      listEl.appendChild(li);
    }

    const atLimit = alamatList.length >= MAX_ALAMAT;
    if (limitMessageEl) limitMessageEl.hidden = !atLimit;
    if (addButton) addButton.hidden = atLimit;
  }

  async function loadList(): Promise<void> {
    try {
      const { items } = await ambilAlamat();
      alamatList = items;
      renderList();
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        showGuestView();
        return;
      }
      showSubmitError(error, "memuat daftar alamat saya");
    }
  }

  async function setDefault(id: string): Promise<void> {
    hideSubmitError();
    try {
      await jadikanAlamatUtama(id);
      await loadList();
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = "Alamat utama diperbarui.";
      }
    } catch (error) {
      showSubmitError(error, "mengubah alamat utama");
    }
  }

  async function deleteAlamat(id: string): Promise<void> {
    if (!window.confirm("Hapus alamat ini?")) return;
    hideSubmitError();
    try {
      await hapusAlamat(id);
      await loadList();
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = "Alamat dihapus.";
      }
    } catch (error) {
      showSubmitError(error, "menghapus alamat");
    }
  }

  async function showAccountView(): Promise<void> {
    if (guestView) guestView.hidden = true;
    if (accountView) accountView.hidden = false;
    await loadList();
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideSubmitError();
    clearFieldErrors();

    const data = new FormData(form);
    const input: AlamatInput = {
      label: String(data.get("label") ?? "").trim(),
      recipientName: String(data.get("recipientName") ?? "").trim(),
      phone: String(data.get("phone") ?? "").trim(),
      provinceCode: String(data.get("provinceCode") ?? ""),
      provinceName: provinceSelect?.selectedOptions[0]?.textContent ?? "",
      cityCode: String(data.get("cityCode") ?? ""),
      cityName: citySelect?.selectedOptions[0]?.textContent ?? "",
      districtCode: String(data.get("districtCode") ?? ""),
      districtName: districtSelect?.selectedOptions[0]?.textContent ?? "",
      postalCode: String(data.get("postalCode") ?? "").trim(),
      street: String(data.get("street") ?? "").trim(),
      notes: String(data.get("notes") ?? "").trim() || null
    };

    const wantsDefault = form.querySelector<HTMLInputElement>('[name="isDefault"]')?.checked ?? false;

    try {
      const saved = editingId ? await ubahAlamat(editingId, input) : await tambahAlamat(input);
      if (wantsDefault && !saved.address.isDefault) {
        await jadikanAlamatUtama(saved.address.id);
      }
      closeForm();
      await loadList();
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = editingId ? "Alamat diperbarui." : "Alamat ditambahkan.";
      }
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "VALIDATION_ERROR") {
        for (const fieldError of error.fieldErrors) {
          const target = form.querySelector<HTMLElement>(`[data-error-for="${fieldError.field}"]`);
          if (target) target.textContent = fieldError.message;
        }
        return;
      }
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        showGuestView();
        return;
      }
      showSubmitError(error, editingId ? "mengubah alamat" : "menambah alamat baru");
    }
  });

  addButton?.addEventListener("click", openFormForCreate);
  cancelFormButton?.addEventListener("click", closeForm);

  function render(): void {
    hideSubmitError();
    const sesi = bacaSesi();
    if (sesi) void showAccountView();
    else showGuestView();
  }

  render();
  window.addEventListener(AKUN_EVENT_NAME, render);
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "awcms-one:akun:v1") render();
  });
}
