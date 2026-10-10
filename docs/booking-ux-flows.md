🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](booking-ux-flows.id.md)

# Booking UX flows — storefront stay booking, deposit, cancellation and front-desk check-in

DoR artifact 8 of epic [#280](https://github.com/ahliweb/awcms-one/issues/280), Wave A item W8 ([#359](https://github.com/ahliweb/awcms-one/issues/359)), tracked in [`aw-business-platform-dor.md`](aw-business-platform-dor.md). Written 10 October 2026.

> **Design specification. Nothing described here is built.** There is no booking page, no booking route, no adapter and no cashier service context in this tree ([`status.md`](status.md) lists them under "not here yet"). ADR-0040 D7 forbids code, migrations and OpenAPI paths until the Definition of Ready is met. Every route name, copy string and state below is a proposal for the phase-1 implementer to confirm; where it conflicts with the code that eventually exists, the code and its tests win and this document is amended.

**Related:** [Platform PRD](aw-business-platform-prd.md) (workflows 4.1 to 4.4, owner answers in section 9), [Threat model](aw-business-platform-threat-model.md) (control mapping, section 7), [Metric contracts](aw-business-platform-metrics.md), [ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (payment ledger and down payment), [ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md) (refunds), [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md), [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.md) (deposit sessions); the visual and accessibility rules this spec follows are [`ui-ux.md`](ui-ux.md), [`aksesibilitas.md`](aksesibilitas.md) and [`responsif.md`](responsif.md).

## 1. Scope and ground rules

In scope: four surfaces for the first vertical (hotel, villa and rental nightly stays, owner answer O2): **(A)** the storefront booking flow, **(B)** deposit payment and the order view, **(C)** cancellation and refund, **(D)** cashier / front-desk check-in with balance collection. Out of scope: admin screens for adapter configuration and for the upstream Booking module's own resources, rates and blocks (those are upstream's admin; the adapter configuration screens are a later item of W8), reminders, and any per-night pricing (deferred upstream by upstream `awcms` ADR-0135 section 6).

Ground rules that every screen inherits:

1. **The storefront computes nothing about money.** Every figure (price per night, total, deposit, paid so far, balance due, refund) is the server's, formatted only through the existing `formatPrice()` path ([`ui-ux.md`](ui-ux.md), "Price presentation"). The page may subtract two server figures only to display a figure the server also returned; it never sends a computed amount back. Control C-07 (deposit amount guard) and C-10 (refund amount computed server-side) are the reason.
2. **Nights are date arithmetic, from the server.** A stay is a half-open local date interval `[check-in, check-out)` in the property's IANA time zone ([upstream ADR-0135](https://github.com/ahliweb/awcms/blob/main/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md) section 2): inclusive check-in, exclusive check-out, nights = check-out minus check-in, at most 366. The browser's own time zone is never used to interpret a stay date; the picker works on date strings (`YYYY-MM-DD`) and labels the property's zone. Same-day turnover is valid (a guest may check in on the day another checks out), so a date that is a check-out of someone else is selectable as a check-in.
3. **Nights are the quantity of one nightly service product** (owner answer Q1): the order has one line, quantity = nights, so "2 nights x Rp 500.000 = Rp 1.000.000" is exactly what the server returns, not a client computation.
4. **Indonesian is the primary language, unconditionally** ([`ui-ux.md`](ui-ux.md), "Language"); the English column below is for the translator and for the English mirror of this document, not a second storefront locale.
5. **Authentication is the existing bearer session** ([ADR-0016](adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D3, control C-04): an opaque `cs_` token in `localStorage`, sent as `Authorization: Bearer`, through `apps/storefront/src/lib/akun-sesi.ts` and `apps/storefront/src/lib/akun-klien.ts`; never a cookie, and CORS gains no credentials header. A `401 UNAUTHENTICATED` from any booking route clears the session and sends the guest to sign-in, then back (section 7). No second session shape is invented.
6. **Static output.** The storefront is `output: "static"` with no `prerender = false` page. Every screen below is a static shell that fetches from `apps/cms` in the browser at runtime (ADR-0007 pattern, as cart and checkout do), so every dynamic region has an explicit loading state, and a static shell with JavaScript disabled shows the no-script state of section 2.1.
7. **Unauthenticated browsing, authenticated reserving.** Search and quote are anonymous (the quote writes no row, PRD 4.1 step 1); creating the hold requires a customer session so the reservation has an owner for the ownership checks of C-05. An identifier in a URL is never proof of ownership (C-02): the order and reservation views load by session, not by a bare reference.

### 1.1 Shared screen-state vocabulary

Every data-bearing region implements these four states, in this order of precedence. The same four apply to each surface below; each surface only lists what differs.

| State   | Rule (all surfaces)                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | A skeleton or text "Memuat..." inside a region marked `aria-busy="true"`; never a blank region. A request that has not answered in 10 seconds becomes the Error state with a retry. The submit button of a form is disabled and shows "Memproses..." while its request is in flight, and the form cannot be submitted twice (the idempotency key of the hold/payment call is generated once per attempt and reused on retry). |
| Empty   | A purposeful message with the next action, reusing `.empty-state`; never an empty table or an empty box.                                                                                                                                                                                                                                                                                                                      |
| Error   | A message that says what happened and what to do, in a `role="alert"` region placed above the form or in the failed region; offers "Coba lagi" where a retry is safe. The message never exposes an internal code, a stack, or whether another tenant or another guest's reference exists (C-02).                                                                                                                              |
| Success | A confirmation in a polite live region (`role="status"`), the next step as a link or button, and focus moved to the confirmation heading.                                                                                                                                                                                                                                                                                     |

## 2. Surface A — storefront booking flow

Route proposal (all under the `toko` profile only, section 8): `/booking` (search and quote), `/booking/pesan` (guest details, hold and payment choice), `/akun/reservasi` (own reservations list and detail, signed in). `/akun/reservasi` lives beside the existing `/akun/*` pages and reuses their layout and sign-in guard.

### 2.1 Step 1 — choose the stay (`/booking`)

Content: a service picker (a nightly-service product, by product card or select), a **date-range picker** for check-in and check-out, a guests/units stepper where the resource has one, and a quote panel.

**Date-range picker behaviour**

- Two native-labelled date fields ("Tanggal masuk", "Tanggal keluar") are the primary, always-available control: `<input type="date">` with `min` = today in the property's zone and a text hint of the zone ("Zona waktu properti: WITA"). A calendar grid is an enhancement over those fields, never a replacement: if the script fails or the guest uses a screen reader, the two inputs still work. This keeps the picker keyboard- and screen-reader-complete by construction.
- Selecting check-in then check-out highlights the half-open range: the check-out date is shown as "keluar" (departure) and is **not** counted as a night. A summary line states the result in words: "2 malam: 12 Okt sampai 14 Okt 2026" (the night count is the server's quote; until it returns, the line says "Menghitung...").
- Check-out must be after check-in; equal dates are an inline error (section 2.5 table), not a silent swap. More than 366 nights is refused with a message, not truncated.
- Availability for a date is shown from the server's availability answer for the chosen service, never inferred. A date with no free unit is marked unavailable in the grid by text and icon ("Penuh"), not by colour alone, and is removed from the tab order of the grid but remains reachable through the date inputs, where choosing it yields the availability error of section 2.5.
- The quote panel (one `aria-live="polite"` region) shows: service name, nights, price per night, total, the deposit due now and the balance due later (section 3.1), and the check-in/check-out times as information ("Check-in mulai 14.00, check-out sebelum 12.00"; these are guest-information fields, not part of the overlap test, upstream `awcms` ADR-0135 section 3).

**States**

| State   | Behaviour                                                                                                                                                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | Service list and availability load into `aria-busy` regions; the quote panel says "Menghitung harga..." and the "Lanjut" button is disabled until a quote for the current dates exists. A date change invalidates the old quote immediately (the old figures are removed, not left stale).     |
| Empty   | No bookable service for this tenant: "Belum ada layanan yang bisa dipesan saat ini." with a link back to the catalogue. No availability in the searched range: "Tidak ada kamar kosong untuk tanggal ini. Coba tanggal lain." with the nearest alternative dates when the server returns them. |
| Error   | Quote or availability request failed: "Tidak dapat memuat harga. Periksa koneksi Anda, lalu coba lagi." + "Coba lagi".                                                                                                                                                                         |
| Success | A valid quote is shown and "Lanjut ke data tamu" is enabled.                                                                                                                                                                                                                                   |

**No-script**: the static shell renders a `<noscript>` message ("Pemesanan memerlukan JavaScript. Hubungi kami di ..." using the site contact from `site.ts`), because a static page cannot quote or hold without the browser calling `apps/cms`.

### 2.2 Step 2 — guest details, hold and the countdown (`/booking/pesan`)

Pressing "Lanjut" (signed in) asks the adapter to **hold** the stay and create the pending order in one business action (PRD 4.1 step 2). Signed-out guests are sent to `/masuk` (OTP) with the chosen service and dates carried in the return address (section 7) and returned to this step afterwards.

Content: stay summary (read-only, with a "Ubah tanggal" link that releases nothing until the new hold replaces it, see below), guest name and contact (prefilled from the account; the contact is used for confirmations only), special-request textarea (length-limited, plain text), a consent line that links the cancellation policy (section 4.1), the deposit amount and the payment-method choice, and the **hold countdown**.

**Hold countdown specification**

- The server returns the hold expiry as an absolute instant (`holdExpiresAt`, UTC) and the server's current instant; the page computes the remaining time from the **difference** (so a wrong device clock does not matter) and re-synchronises when the page regains visibility or the network returns.
- Visible text: "Kamar ditahan untuk Anda selama 14:32" (mm:ss; hh:mm:ss above one hour). Below 60 seconds the text gains a warning style **and** the words "kurang dari 1 menit".
- **Live-region rule (WCAG 4.1.3, and 2.2.1 timing)**: the ticking digits are **not** in a live region (a per-second announcement is unusable). A separate visually-hidden `role="status"` region announces only at these thresholds: when the hold starts ("Kamar ditahan selama 15 menit"), at 5 minutes, at 1 minute, and at expiry; the 1-minute and expiry announcements use `role="alert"`. The countdown never steals focus.
- **Time-limit control (WCAG 2.2.1)**: at the 1-minute threshold a "Perpanjang waktu tahan" button appears once, if the server allows an extension (a single extension, server-decided, rate limited by C-03); if it does not, the message says so. A guest who needs more time can therefore turn off, adjust or extend the limit, or start again.
- At expiry the form is disabled and replaced by the expired state ("Waktu penahanan habis. Kamar dilepas. Pilih tanggal lagi.") with a primary button back to Step 1 with the same dates prefilled. The page treats the server as authoritative: a submit that arrives after expiry is answered `HOLD_EXPIRED` and shown as the same state, however the local timer read.
- `prefers-reduced-motion`: the countdown has no animation in any case; the progress bar, if used, does not animate under that preference.

**States**

| State   | Behaviour                                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | While the hold is being created: "Menahan kamar..." and the form hidden (so a double press cannot create a second hold; the hold call is idempotent on a client key regardless). |
| Empty   | Visiting the page with no active hold (reload after expiry, or a direct link): "Tidak ada pemesanan yang sedang berjalan." with a link to `/booking`.                            |
| Error   | The error table of section 2.5. Focus moves to the alert; the form keeps what the guest typed.                                                                                   |
| Success | Hold active: the countdown, the summary and the payment choice are shown. Submitting the payment choice goes to Surface B.                                                       |

### 2.3 Own reservations (`/akun/reservasi`)

A signed-in list of the guest's reservations, newest first: stay dates, nights, service, reservation status (section 2.4 vocabulary), payment status (section 3.3), balance due. Each row links to the detail, which hosts Surface B's order view and Surface C's cancellation. Ownership is computed from the session (C-05); a reference of someone else's returns the same neutral "Pemesanan tidak ditemukan" as a nonexistent one (C-02).

| State   | Behaviour                                                                                |
| ------- | ---------------------------------------------------------------------------------------- |
| Loading | `aria-busy` list with skeleton rows.                                                     |
| Empty   | "Anda belum punya reservasi." + "Cari penginapan" link.                                  |
| Error   | "Tidak dapat memuat reservasi." + retry; `401` clears the session and sends to `/masuk`. |
| Success | The list; a returning guest from payment lands here with a status message (section 3.2). |

### 2.4 Status vocabulary

One small `Record` per surface, never the raw API enum ([`ui-ux.md`](ui-ux.md), "Status-label vocabulary"). A label is always text; the `.pill` colour is reinforcement, never the only signal.

| Reservation state (upstream) | Indonesian label              | English          | Pill    |
| ---------------------------- | ----------------------------- | ---------------- | ------- |
| `held`                       | Menunggu pembayaran uang muka | Awaiting deposit | warning |
| `confirmed`                  | Terkonfirmasi                 | Confirmed        | success |
| `checked_in`                 | Sedang menginap               | Checked in       | info    |
| `completed`                  | Selesai                       | Completed        | neutral |
| `expired`                    | Penahanan habis               | Hold expired     | neutral |
| `cancelled`                  | Dibatalkan                    | Cancelled        | danger  |
| `rescheduled`                | Dijadwalkan ulang             | Rescheduled      | neutral |
| `no_show`                    | Tidak hadir                   | No-show          | danger  |

### 2.5 Availability and booking errors

Each error is shown inline next to the field it concerns (or at the top of the form for form-level errors) with the association rules of section 6, and each names the next action. The page maps the server's refusal code to copy; an unknown code uses the generic row.

| Condition (server answer)                                                | Indonesian                                                                  | English                                                                     | Next action                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Check-out not after check-in                                             | Tanggal keluar harus setelah tanggal masuk.                                 | Check-out must be after check-in.                                           | Focus the check-out field.                                                   |
| Date in the past                                                         | Tanggal masuk tidak boleh sebelum hari ini.                                 | Check-in cannot be before today.                                            | Focus check-in.                                                              |
| More than 366 nights                                                     | Lama menginap maksimal 366 malam.                                           | Maximum stay is 366 nights.                                                 | Focus check-out.                                                             |
| No unit free for the range (the exclusion constraint lost, or none free) | Maaf, kamar untuk tanggal ini baru saja terisi. Silakan pilih tanggal lain. | Sorry, this room was just taken for these dates. Please choose other dates. | Return to Step 1 with dates kept; show alternatives if returned.             |
| Night blocked (maintenance / owner use)                                  | Tanggal ini tidak tersedia untuk dipesan.                                   | These dates are not available.                                              | As above. The page does not say why (a block's reason is staff information). |
| Hold expired                                                             | Waktu penahanan habis.                                                      | The hold has expired.                                                       | Step 1 with dates kept.                                                      |
| Rate limited (C-03)                                                      | Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.                  | Too many attempts. Please wait and try again.                               | Retry control after the server's wait time.                                  |
| Session expired (`401`)                                                  | Sesi Anda berakhir. Masuk lagi untuk melanjutkan.                           | Your session expired. Sign in to continue.                                  | Sign-in, then return with the stay preserved.                                |
| Network / unknown                                                        | Terjadi gangguan. Coba lagi.                                                | Something went wrong. Try again.                                            | Retry; the idempotent call makes this safe.                                  |

A "no unit free" answer is never an empty success: the page must show the message, because a race between two guests is decided by the database and the loser must be told plainly.

## 3. Surface B — deposit payment and the order view

### 3.1 Deposit and balance presentation

The deposit is a per-product policy (owner answer Q2: percentage or fixed amount, no tenant default; a product with no policy takes full payment). The server returns, with the quote and the order: the total, the **deposit due now**, the **balance due later**, and the payment state. The page shows exactly those, in a definition list (three rows, labelled terms), at the quote (Step 1), at payment (Step 2) and in the order view:

| Row                                  | Indonesian label                      | English         | Source                                                   |
| ------------------------------------ | ------------------------------------- | --------------- | -------------------------------------------------------- |
| Total                                | Total                                 | Total           | order total                                              |
| Paid so far                          | Sudah dibayar                         | Paid so far     | settled allocations on the ledger (not the pending ones) |
| Balance due                          | Sisa pembayaran                       | Balance due     | server-provided outstanding balance                      |
| Due now (before the deposit is paid) | Uang muka yang harus dibayar sekarang | Deposit due now | server-computed deposit (`dp_amount`, ADR-0041 D4)       |

A product with no deposit policy hides the deposit row and shows "Bayar penuh" (pay in full) with the total as the amount due. **Points are not offered on a deposit order and a refundable security deposit does not exist in v1** (owner answers Q8 and Q3; ADR-0041 D8): the checkout does not render a points redemption control when the order has a deposit, and shows a short text explaining that points cannot be combined with an uang muka ("Poin tidak dapat dipakai bersama uang muka."), and no "deposit jaminan" (security deposit) line or label is rendered anywhere. A refund may return the earned deposit under ADR-0033; the UI calls it "uang muka", never "deposit jaminan".

### 3.2 Paying the deposit

The deposit is paid through an existing tender: the Midtrans gateway session whose expected amount is the server-computed deposit (ADR-0041 D1/D2), manual transfer, or QRIS. The flow reuses the redirect-based checkout pattern ([`ui-ux.md`](ui-ux.md), "Checkout and tracking"): the page sends the guest to the provider and receives them back on the stay's detail page. The guest never sends an amount; the amount shown is the server's, and the amount the provider charges is guarded server-side (C-07).

Returning from the provider is **not proof of payment** (C-06, C-08): the return page reads the order's state from the server and shows one of:

| Server state on return                                    | Indonesian                                                                                                                                                                        | English                                                                                                                                    | Pill / next                                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Deposit settled, reservation `confirmed`, order `dp_paid` | Uang muka diterima. Reservasi Anda terkonfirmasi. Sisa pembayaran Rp X dibayar saat check-in atau lebih awal.                                                                     | Deposit received. Your reservation is confirmed. Balance Rp X is due at check-in or earlier.                                               | success                                                                                                           |
| Payment pending (provider has not confirmed)              | Pembayaran sedang diproses. Halaman ini diperbarui otomatis. Kamar tetap ditahan sampai HH:MM.                                                                                    | Payment is being processed. This page updates automatically. The room stays held until HH:MM.                                              | info; poll politely (backoff, stop after the hold expiry), announce changes via the status region                 |
| Payment failed or cancelled                               | Pembayaran tidak berhasil. Anda bisa mencoba metode lain selama kamar masih ditahan.                                                                                              | Payment did not succeed. You may try another method while the room is held.                                                                | danger; "Bayar lagi" if the hold is live                                                                          |
| Hold expired before payment settled                       | Waktu penahanan habis sebelum pembayaran kami terima. Jika Anda sudah membayar, tim kami akan menghubungi Anda untuk pengembalian dana atau penjadwalan ulang. Nomor pesanan: ... | The hold expired before we received payment. If you already paid, our team will contact you about a refund or rebooking. Order number: ... | warning; this is the late-payment exception of PRD 4.1 step 6 (C-08): the page never claims the room is confirmed |

The page does not claim "confirmed" from a redirect parameter alone.

### 3.3 Order view with the deposit state

The reservation detail shows the stay (dates in the property's zone, nights, check-in/out times), the order number, the status pills, the three money rows of section 3.1, and the payment history (each allocation: date, tender, amount, status; amounts in the server's formatting). The payment-status label vocabulary:

| Order payment state                                      | Indonesian                         | English                      | Pill    |
| -------------------------------------------------------- | ---------------------------------- | ---------------------------- | ------- |
| awaiting payment                                         | Menunggu pembayaran                | Awaiting payment             | warning |
| `dp_paid`                                                | Uang muka dibayar, sisa Rp X       | Deposit paid, Rp X remaining | info    |
| paid in full (settlement reached the total, ADR-0041 D6) | Lunas                              | Paid in full                 | success |
| refunded in part / full                                  | Dikembalikan sebagian / seluruhnya | Partly / fully refunded      | neutral |

Actions available by state: "Bayar sisa pembayaran" (balance payment through the same tenders, any time before or at check-in; hidden when the balance is zero), "Batalkan reservasi" (Surface C), "Unduh kuitansi" (the numbered order document, ADR-0029; Booking issues no document). The balance payment is also what a cashier takes at the front desk (Surface D).

| State   | Behaviour                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------- |
| Loading | `aria-busy` detail with skeleton rows for the money list.                                               |
| Empty   | Not applicable (a detail without a reservation is the neutral not-found).                               |
| Error   | Neutral "Pemesanan tidak ditemukan" for unknown and not-yours alike (C-02); a load failure shows retry. |
| Success | The detail; after a payment, the status region announces the new state.                                 |

## 4. Surface C — cancellation and refund view

### 4.1 Policy windows, per product with a tenant default

Cancellation windows are per product, with a tenant-wide default for a product that has none of its own (owner answer Q9). The guest sees the policy that **applies to this product**, resolved by the server, at three points: in the consent line before paying the deposit (Step 2), on the reservation detail, and in the cancellation dialog. It is rendered as a short table, not prose only:

| Cancel at least                 | Refund of what was paid | Indonesian                                                         | English                                      |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Example: 7 days before check-in | 100%                    | Batal paling lambat 7 hari sebelum check-in: dana kembali 100%.    | Cancel 7+ days before check-in: 100% refund. |
| Example: 2 to 7 days            | 50%                     | Batal 2 sampai 7 hari sebelum check-in: dana kembali 50%.          | Cancel 2 to 7 days before: 50% refund.       |
| Example: under 2 days / no-show | 0%                      | Batal kurang dari 2 hari atau tidak hadir: tidak ada pengembalian. | Under 2 days or no-show: no refund.          |

The rows are examples of the shape; the numbers are the tenant's policy, read from the server, never hard-coded. When the policy is not resolved (no product policy and no tenant default), the page says "Kebijakan pembatalan belum ditetapkan. Hubungi kami sebelum membatalkan." and does **not** offer the cancel button's self-service refund path (the guest may still request cancellation; the amount then follows the staff path). The cut-off is stated with the property's zone and as a concrete local date and time ("sampai 5 Okt 2026 14.00 WITA"), derived by the server from the stay's snapshotted arrival instant and cutoff.

### 4.2 The cancellation dialog — refund shown before confirming

Pressing "Batalkan reservasi" opens a confirm dialog (the existing accessible confirm-dialog pattern; never a browser `confirm`, which the admin gates already forbid and the storefront does not use either). The dialog **loads the server's refund preview first**: the policy window the cancellation falls in, the amount paid, the refundable amount, and what is retained. Nothing is cancelled by opening the dialog.

| Row                | Indonesian                                                     | English                                 |
| ------------------ | -------------------------------------------------------------- | --------------------------------------- |
| Paid               | Sudah dibayar                                                  | Paid                                    |
| Policy applied     | Kebijakan yang berlaku: batal 2 sampai 7 hari sebelum check-in | Policy applied                          |
| Refund             | Dana yang dikembalikan                                         | Refund                                  |
| Retained           | Ditahan sesuai kebijakan                                       | Retained under the policy               |
| Refund destination | Dikembalikan ke metode pembayaran asal (Midtrans, transfer)    | Refunded to the original payment method |

Copy: title "Batalkan reservasi ini?"; body states the three figures; buttons "Ya, batalkan dan ajukan pengembalian" (danger) and "Tidak, tetap pesan" (default focus). A zero refund changes the confirm button to "Ya, batalkan tanpa pengembalian" and shows the retained amount in the warning pill, so a guest never discovers a forfeit after the fact. The refund shown is a **preview**; after confirming, the figure on the result is the recorded refund. If the preview and the recorded figure differ (the policy window passed while the dialog was open), the server refuses with the new preview and the dialog re-renders it for a fresh confirmation; the guest is never charged a different figure silently.

| State   | Behaviour                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading | Dialog body `aria-busy` "Menghitung pengembalian dana..."; confirm disabled until the preview arrives.                                                                                                                                                                                                                                                                                  |
| Empty   | A reservation that can no longer be cancelled (completed, already cancelled, past check-in): the button is replaced with a plain-text reason ("Reservasi ini sudah selesai dan tidak dapat dibatalkan.") rather than hidden.                                                                                                                                                            |
| Error   | Preview failed: "Tidak dapat menghitung pengembalian dana. Coba lagi." + retry; confirm stays disabled. Cancel request failed: alert in the dialog, nothing assumed.                                                                                                                                                                                                                    |
| Success | Dialog closes; the detail shows "Dibatalkan" and a status message: "Reservasi dibatalkan. Pengembalian dana Rp X sedang diproses; biasanya ... hari kerja." The refund line then follows its own states: processing, completed, or "menunggu verifikasi tim kami" when the settlement is queued for an operator's offline attestation (ADR-0033; control C-11), never silently dropped. |

A refund that cannot settle automatically is shown to the guest as "sedang diproses" with the reference number, never as an error that invites a second cancellation; the cancel call is idempotent (C-10).

### 4.3 Staff override (back-office only)

A **guest cannot override anything.** The storefront has no control that changes a refund amount. Override is a staff action in the admin / front-desk context (owner answer Q10; PRD 4.2 step 6; A5): it requires a **manager or finance permission** held separately from the ordinary cancel permission, **step-up re-authentication**, a **mandatory reason**, an **audit event**, and an amount **never above what was paid**. The screen for it is an admin screen of the adapter (a later W8 item); this spec fixes only its UX contract:

- The override control is absent (not disabled) for staff without the permission.
- The form shows the policy-computed amount beside the override field, requires a reason (minimum length, free text, plain), and states the cap ("Maksimal Rp X: sebesar yang sudah dibayar").
- Submitting triggers step-up re-authentication; the override is recorded only after it succeeds, and a failed or abandoned step-up changes nothing.
- The result is audited with the actor, the policy figure, the override figure and the reason; the guest-facing view then shows the recorded refund and, at most, "Disesuaikan oleh tim kami" (adjusted by our team), never the reason or the actor.

## 5. Surface D — cashier / front-desk check-in with balance collection

The surface lives in the POS (a register session and cash-up from ADR-0028 are unchanged, PRD 4.4); it is a staff surface, signed in as staff with the cashier role, not a storefront page, and is built on the existing POS screens' patterns. It writes to the same order and ledger; there is no second POS, and the POS stores no reservation state (check-in and check-out call Booking's port).

### 5.1 Flow

1. **Find the reservation**: scan or type a booking reference or search by guest name/phone and arrival date. The search shows only the tenant's own reservations (C-01); a reference not found shows "Reservasi tidak ditemukan" with no hint about other tenants.
2. **Open the service line**: the POS shows a reservation card: guest, unit/room, dates and nights, status pill, and the three money rows (total, paid so far, **balance due**), identical in vocabulary to section 3.1. The card links the order.
3. **Collect the balance**: the cashier takes the balance through the existing explicit-tenders path (ADR-0025 D8), with any tender and with split tenders; the balance due is the server's figure and the tender entry rejects an amount above it. Points redemption and a refundable security deposit are not offered (Q8 and Q3).
4. **Check in**: enabled when the reservation is `confirmed`. Whether check-in with an unpaid balance is allowed is **tenant policy**, a decision the owner has not recorded; this spec shows both variants in one control: if the policy requires the balance first, "Check-in" is disabled with the visible reason "Lunasi sisa pembayaran dulu" next to it; otherwise check-in is enabled and the balance stays visible. Pending decision; see section 10.
5. **Check-out**: `checked_in` becomes `completed` through the same control. A stay shortened at check-out is a partial return of the service line (PRD section 3; ADR-0033 D2), started from the order, never an edit of the finalised order.
6. **Receipt**: the numbered receipt/invoice is the order's document through the existing document lifecycle (ADR-0029); the screen offers print and send.

### 5.2 States

| State   | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loading | Reservation card `aria-busy`; action buttons disabled until the order's settlement has loaded (so a balance is never shown as zero by default).                                                                                                                                                                                                                                                                                      |
| Empty   | No reservations arriving today: "Tidak ada kedatangan hari ini." and a search box; a search with no result: "Reservasi tidak ditemukan." and an option to create a walk-in service sale with no reservation (PRD 4.4 step 2).                                                                                                                                                                                                        |
| Error   | Payment failed on a tender: an alert beside the tender row, with the balance unchanged; the cashier can try again or choose another tender. A check-in refused by Booking (state changed elsewhere): the card re-loads and shows the current status with "Status reservasi berubah. Data diperbarui." No register session open: "Buka sesi kasir sebelum menerima pembayaran." with a link to open it, and tender entry is disabled. |
| Success | Balance collected: status region "Sisa pembayaran Rp X diterima. Pesanan lunas." and the order shows "Lunas"; full settlement is what loyalty earns on (PRD 4.6), not the deposit (Q5). Check-in complete: card shows "Sedang menginap".                                                                                                                                                                                             |

Copy (Indonesian, English): "Terima sisa pembayaran" / Collect balance; "Check-in tamu" / Check in guest; "Check-out tamu" / Check out guest; "Sesi kasir belum dibuka" / Register session is not open.

### 5.3 Controls (front-desk specific)

Every balance-collection and check-in/check-out write is audited with the actor and the register session (carried by the existing POS audit). A cashier cannot override a refund or cancel a paid reservation with a refund from this surface; both are Surface C's back-office path with the permissions of section 4.3.

## 6. Accessibility requirements (WCAG 2.1 AA)

These are requirements on the implementation, added to the floor in [`aksesibilitas.md`](aksesibilitas.md); the e2e suite described there (axe-core `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`, `serious`/`critical`) must scan each new storefront page in `toko` once it exists. Automated tools catch a fraction of these; the manual checks in the last column are part of acceptance.

| Area                  | Requirement                                                                                                                                                                                                                                                                                                                                             | WCAG                              | Manual check                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| Keyboard              | Every control is reachable and operable by keyboard in a logical order; the date grid supports arrow keys (day), Page Up / Page Down (month), Home / End (week), Enter/Space to select, Escape to close; nothing traps focus except the modal dialogs, which trap and restore it. The two native date inputs always remain as the complete alternative. | 2.1.1, 2.1.2, 2.4.3               | Complete a booking with the keyboard only                                  |
| Focus                 | A visible focus indicator on every control at 3:1 against adjacent colours (the design system's focus ring); after a step change, an error summary or a dialog opens/closes, focus is moved deliberately (heading, first invalid field, the control that opened the dialog). Sticky headers never obscure the focused control.                          | 2.4.7, 2.4.3, 3.2.1               | Tab through each step                                                      |
| Labels                | Each field has a visible `<label>` bound by `for`/`id`; the picker's grid has an accessible name and each day button a full name ("Senin, 12 Oktober 2026, tersedia" / "penuh"); required fields are marked in text, not by colour; the zone hint and the format hint are tied to the input with `aria-describedby`. Placeholder is never the label.    | 1.3.1, 3.3.2, 4.1.2               | Screen reader pass on iOS VoiceOver and Android TalkBack                   |
| Errors                | Each error is a text message associated with its field (`aria-describedby` plus `aria-invalid="true"`), written in the language of section 2.5, with a form-level `role="alert"` summary that links to the first invalid field and takes focus on a failed submit; errors state the correction, not only the fault.                                     | 3.3.1, 3.3.3, 4.1.3               | Submit empty and invalid forms                                             |
| Contrast              | Text 4.5:1 (3:1 for 18px+/14px bold), UI components and focus indicators 3:1, using the existing tokens; nothing below `--text-xs` (12px); the pill and the unavailable-date mark carry a text label, never colour alone.                                                                                                                               | 1.4.3, 1.4.11, 1.4.1              | Axe plus a manual token check in light and dark if the storefront has both |
| Live regions          | The quote panel is `aria-live="polite"`; payment-state changes and the confirmation use `role="status"`; the hold countdown follows section 2.2 (threshold announcements only, `role="alert"` at one minute and expiry); no region announces on every tick; regions exist in the DOM before their content changes.                                      | 4.1.3, 2.2.1                      | Screen reader pass; check no per-second chatter                            |
| Timing                | The hold is a time limit: the guest is told at the start, warned before expiry and offered an extension where the server permits it; there is no hidden timeout, and a session expiry never loses the chosen stay (section 7).                                                                                                                          | 2.2.1, 2.2.6                      | Let a hold run out                                                         |
| Target size           | Controls are at least 44px (the existing rule), including the date-grid day buttons at 360px; a day button is not smaller than 44px by 44px, so the grid shows fewer columns per row rather than shrinking cells (a 7-column grid at 360px minus the 16px gutters is 328px, 46px per cell, which fits).                                                 | 2.5.5 (AAA, applied by repo rule) | Measure at 360px                                                           |
| Reflow                | No horizontal scroll at 360px, no two-dimensional scroll; content reflows at 400% zoom (320 CSS px).                                                                                                                                                                                                                                                    | 1.4.10                            | Zoom to 400%                                                               |
| Text spacing and zoom | Layout survives the WCAG 1.4.12 text-spacing overrides and 200% text resize without loss of content or function.                                                                                                                                                                                                                                        | 1.4.4, 1.4.12                     | Apply the spacing bookmarklet                                              |
| Motion                | No auto-playing animation; `prefers-reduced-motion` removes transitions; nothing flashes.                                                                                                                                                                                                                                                               | 2.2.2, 2.3.1                      | Toggle the OS setting                                                      |
| Dialog                | The cancellation dialog is a modal with an accessible name and description (the refund figures), focus moves into it and returns to the opener on close, Escape closes it without cancelling, and the background is inert.                                                                                                                              | 2.1.2, 4.1.2                      | Keyboard and screen reader                                                 |
| Language              | `lang="id"` on the document; any English fragment (a provider name) carries its own `lang`.                                                                                                                                                                                                                                                             | 3.1.1, 3.1.2                      | Axe                                                                        |
| Cashier surface       | The same rules; additionally every keyboard shortcut is discoverable, can be turned off or remapped where a single-character shortcut exists, and the balance and the status are text, not colour (WCAG 2.1.4).                                                                                                                                         | 2.1.4                             | Keyboard pass at a POS terminal                                            |

## 7. Responsive layout, 360px

The storefront is verified by a real browser at 360px and 1280px asserting `document.documentElement.scrollWidth <= window.innerWidth` on every key page ([`responsif.md`](responsif.md)); each booking page joins that list in `toko` once built. Rules for the layout:

- Single column below the existing 720px/860px breakpoints; the quote panel sits below the form, and the three money rows stack as label-over-value (a definition list, not a table) so nothing needs horizontal scroll.
- The date picker shows **one month** at 360px; two months only at 860px and above. Grid tracks use `minmax(0, 1fr)` (the bare `1fr` overflow fixed in issue #183) and day cells are at least 44px square.
- The payment-history list on the order view is a stacked list at 360px (each allocation a card), not a table; where a real table is kept on wider screens it sits in the focusable named `.data-table-scroll` region.
- The cancellation dialog is a bottom sheet or a full-width dialog at 360px with its buttons stacked, the safe choice ("Tidak, tetap pesan") first in DOM order after the figures; long strings (a long guest name, a long reference) wrap (`overflow-wrap: anywhere`) and never widen the dialog.
- The sticky "Lanjut" bar (if used) never covers the focused field (scroll-padding), and the hold countdown is visible without scrolling at the top of Step 2.
- The cashier surface is designed for a tablet or a phone as well as a desktop: the reservation card and the tender entry stack on one column at 360px, with 44px controls.

Return-after-sign-in: the chosen service and dates are carried in the return address as plain `YYYY-MM-DD` values (never an amount), validated again on return; nothing booking-related is stored in `localStorage` apart from the session under `awcms-one:akun:v1`.

## 8. Behaviour under the three build profiles

`SITE_PROFILE` is read at build time by `apps/storefront/src/config/profil.ts`. Booking is a commerce capability and belongs **only** to the `toko` profile:

| Profile   | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `toko`    | The booking pages (`/booking`, `/booking/pesan`, `/akun/reservasi`) are profile pages under the `toko` group (`apps/storefront/src/profil/toko/pages/**`), injected by the profile integration; header and footer may link to `/booking` only in this profile; the tenant switch that turns booking off hides the links and makes the routes show "Pemesanan tidak tersedia" rather than a broken form. The new pages must appear exactly once in [`template.md`](template.md)'s profile matrix. |
| `berita`  | No booking page is built; no link to one is rendered anywhere (the existing check that no built page links to a route outside its own profile covers this). A booking URL is a 404.                                                                                                                                                                                                                                                                                                              |
| `landing` | Same as `berita`: no booking page and no booking link. A landing site that wants an enquiry uses the existing contact page; it does not get a half-working booking form.                                                                                                                                                                                                                                                                                                                         |

In every profile the build stays static and a profile that does not include booking carries none of its client script (no dead code ships). A site that combines a landing page with booking is a `toko` build with its landing content, not a fourth profile. The cashier surface is a back-office (`apps/cms`) surface and is independent of the storefront profile.

## 9. Controls and traceability

| Concern                                      | Control (threat model section 7) | Where it shows in this spec                                        |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| Tenant from origin only                      | C-01                             | No tenant selector anywhere; cashier search is tenant-scoped (5.1) |
| No enumeration, neutral not-found            | C-02                             | 2.3, 3.3, 5.1                                                      |
| Rate limits on holds and OTP                 | C-03                             | 2.2 (extension), 2.5                                               |
| Bearer session, no cookie                    | C-04                             | Ground rule 5, section 7                                           |
| Ownership on each ID endpoint                | C-05                             | 2.3, 3.3                                                           |
| Webhook intake: the return page is not proof | C-06                             | 3.2                                                                |
| Deposit amount guard, server-computed        | C-07                             | Ground rule 1, 3.1, 3.2                                            |
| Late-payment / hold-expiry race              | C-08                             | 3.2 (last row)                                                     |
| Refund idempotency, server amount            | C-10                             | 4.2                                                                |
| Separation of duties on offline refunds      | C-11                             | 4.2 (offline), 4.3                                                 |

The threat model on this branch stops at C-24, so no later control (for example any C-37 to C-41 range) is cited; when such controls land, this section gains their rows.

## 10. Decisions not recorded (assumptions to confirm)

1. **Check-in with an unpaid balance**: tenant policy (block or allow) is not an owner answer; section 5.1 shows both variants and the phase-1 owner decides before build.
2. **Hold length and the extension rule**: the countdown shows whatever the server sets; the 15-minute figure in copy is illustrative, and whether one extension is allowed is a Booking/adapter decision.
3. **Guests/units stepper and multi-unit stays**: a stay is on one unit in v1 (upstream `awcms` ADR-0135 section 4); multi-room bookings are not specified here.
4. **Route names** are proposals; the phase-1 implementer fixes them and updates [`routing.md`](routing.md) and the profile matrix in the same change.
5. **Alternative-date suggestions** in the no-availability state depend on an availability endpoint capability that is upstream's to define.
6. **Whether the guest sees the late-payment exception contact** (3.2) as a phone, WhatsApp or e-mail is the tenant's configuration.
7. **Unknown-until-built**: all pixel-level design (spacing, the exact calendar visual) is the redesign design system's ([`ui-ux.md`](ui-ux.md)); this spec states behaviour, not a mock-up.
