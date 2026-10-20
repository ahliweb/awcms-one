🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](booking-ux-flows.id.md)

# Booking UX flows — storefront stay booking, deposit, cancellation and front-desk check-in

DoR artifact 8 of epic [#280](https://github.com/ahliweb/awcms-one/issues/280), Wave A item W8 ([#359](https://github.com/ahliweb/awcms-one/issues/359)), tracked in [`aw-business-platform-dor.md`](aw-business-platform-dor.md). Written 10 October 2026.

> **Design specification, partly built.** Surface A (the storefront booking flow: `/booking`, `/booking/pesan`, `/akun/reservasi`, with their countdown, expired and own-list states) is built by [issue #386](https://github.com/ahliweb/awcms-one/issues/386); see "Implementation status of Surface A" below for exactly what it does and where it deliberately differs from this text. Surface B's payment handoff is the existing gateway session (deposit and balance purposes) reached from those pages; the order view with its payment history, **Surface C (cancellation and refund), Surface D (the cashier check-in) and every back-office screen are not built** (issues #381 to #383 and later). Every route name, copy string and state below that is not built remains a proposal for its implementer to confirm; where this text conflicts with the code, the code and its tests win and this document is amended.

**Related:** [Platform PRD](aw-business-platform-prd.md) (workflows 4.1 to 4.4, owner answers in section 9), [Threat model](aw-business-platform-threat-model.md) (control mapping, section 7), [Metric contracts](aw-business-platform-metrics.md), [ADR-0025](adr/0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (payment ledger and down payment), [ADR-0033](adr/0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md) (refunds), [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md), [ADR-0041](adr/0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.md) (deposit sessions); the visual and accessibility rules this spec follows are [`ui-ux.md`](ui-ux.md), [`aksesibilitas.md`](aksesibilitas.md) and [`responsif.md`](responsif.md).

## 1. Scope and ground rules

In scope: four surfaces for the first vertical (hotel, villa and rental nightly stays, owner answer O2): **(A)** the storefront booking flow, **(B)** deposit payment and the order view, **(C)** cancellation and refund, **(D)** cashier / front-desk check-in with balance collection. Out of scope: admin screens for adapter configuration and for the upstream Booking module's own resources, rates and blocks (those are upstream's admin; the adapter configuration screens are a later item of W8), reminders, and any per-night pricing (deferred upstream by upstream `awcms` ADR-0135 section 6).

Ground rules that every screen inherits:

1. **The storefront computes nothing about money.** Every figure (price per night, total, deposit, paid so far, balance due, refund) is the server's, formatted only through the existing `formatPrice()` path ([`ui-ux.md`](ui-ux.md), "Price presentation"). The page may subtract two server figures only to display a figure the server also returned; it never sends a computed amount back. Control C-07 (deposit amount guard) and C-10 (refund amount computed server-side) are the reason.
2. **Nights are date arithmetic, from the server.** A stay is a half-open local date interval `[check-in, check-out)` in the property's IANA time zone ([upstream `awcms` ADR-0135](../apps/cms/docs/adr/0135-day-granularity-stays-admitted-into-booking-v1.md) section 2): inclusive check-in, exclusive check-out, nights = check-out minus check-in, at most 366. The browser's own time zone is never used to interpret a stay date; the picker works on date strings (`YYYY-MM-DD`) and labels the property's zone. Same-day turnover is valid (a guest may check in on the day another checks out), so a date that is a check-out of someone else is selectable as a check-in.
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

A **guest cannot override anything.** The storefront has no control that changes a refund amount. Override is a staff action in the admin / front-desk context (owner answer Q10; PRD 4.2 step 6; A5): it requires a **manager or finance permission** held separately from the ordinary cancel permission, **step-up re-authentication**, a **mandatory reason**, an **audit event**, and an amount **never above what was paid**. The screen for it is an admin screen of the adapter, specified in section 11.5 and built by [#381](https://github.com/ahliweb/awcms-one/issues/381); this section fixes the UX contract:

- The override control is absent (not disabled) for staff without the permission.
- The form shows the policy-computed amount beside the override field, requires a reason (minimum length, free text, plain), and states the cap ("Maksimal Rp X: sebesar yang sudah dibayar").
- Submitting triggers step-up re-authentication; the override is recorded only after it succeeds, and a failed or abandoned step-up changes nothing.
- The result is audited with the actor, the policy figure, the override figure and the reason; the guest-facing view then shows the recorded refund and, at most, "Disesuaikan oleh tim kami" (adjusted by our team), never the reason or the actor.

## 5. Surface D — cashier / front-desk check-in with balance collection

The surface lives in the POS (a register session and cash-up from ADR-0028 are unchanged, PRD 4.4); it is a staff surface, signed in as staff with the cashier role, not a storefront page, and is built on the existing POS screens' patterns. It writes to the same order and ledger; there is no second POS, and the POS stores no reservation state (check-in and check-out call Booking's port).

### 5.1 Flow

1. **Find the reservation**: type or scan the reservation code AND enter the customer's phone or e-mail; both are required and matched exactly (control C-34, built by [#383](https://github.com/ahliweb/awcms-one/issues/383)). There is no search by name, date or part of a code, and no list of arrivals: a code alone or a name alone finds nothing, so the till cannot be used to list a tenant's guests. A code that does not exist, a code with the wrong customer and another tenant's code all show the same "Reservasi tidak ditemukan" with no hint of which it was; repeated misses are rate-limited and every lookup is audited. The card shows the contact masked and is held in memory only - it is cleared on the next sale and at the end of the shift, never kept in browser storage.
2. **Open the service line**: the POS shows a reservation card: guest, unit/room, dates and nights, status pill, and the three money rows (total, paid so far, **balance due**), identical in vocabulary to section 3.1. The card links the order.
3. **Collect the balance**: the cashier takes the balance through the existing explicit-tenders path (ADR-0025 D8), with any tender and with split tenders; the balance due is the server's figure and the tender entry rejects an amount above it. Points redemption and a refundable security deposit are not offered (Q8 and Q3).
4. **Check in**: enabled when the reservation is `confirmed`. Whether check-in with an unpaid balance is allowed is **tenant policy**, a decision the owner has not recorded; this spec shows both variants in one control: if the policy requires the balance first, "Check-in" is disabled with the visible reason "Lunasi sisa pembayaran dulu" next to it; otherwise check-in is enabled and the balance stays visible. Decided by [ADR-0045](adr/0045-booking-commerce-adapter.md) D19: a tenant setting `checkin_requires_settlement` (API `checkinRequiresSettlement`, a checkbox on the commerce settings screen), default **`true` (block)** since #383 - the owner confirms the default (residual R3) and may switch it off. The server enforces it with `409 BALANCE_NOT_SETTLED`; the card says so in `policy.checkInRequiresSettlement` and `actions.checkInBlockedReason`.
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

**Server side built by [#383](https://github.com/ahliweb/awcms-one/issues/383) (the screens are [#388](https://github.com/ahliweb/awcms-one/issues/388)).** The API under `/api/v1/commerce/pos/booking/` gives the screen: a lookup (`POST lookup`: code plus phone or e-mail) that returns the reservation card of 5.1 - status, dates, the service line the product priced, the ledger's three money rows, the masked contact, the policy and the `actions` hints - and the three writes, each its own permission and each naming the register whose open session the cashier holds: `check-in`, `check-out` and `balance-payments` (explicit tenders, split tenders, change for cash). The body of a write never carries a price or a balance. Two things in 5.2 are not served by it: there is **no arrivals list** ("Tidak ada kedatangan hari ini."), because a list of the day's guests is exactly the enumeration C-34 forbids at the till; and a walk-in service sale with no reservation is the ordinary POS sale. An error `REGISTER_SESSION_REQUIRED` is the copy "Buka sesi kasir sebelum menerima pembayaran." with the link to open the session; `BALANCE_NOT_SETTLED` is "Lunasi sisa pembayaran dulu".

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
| Redemption not combined with a deposit       | C-33                             | 3.1 (points control hidden on a deposit order)                     |
| POS lookup: code plus customer, neutral miss | C-34                             | 5.1                                                                |
| POS permission separation                    | C-35                             | 5.1, 5.2                                                           |
| Reschedule and cancellation window integrity | C-37                             | 4.1 (window), 11.6 (the reschedule dialog; built by #382)          |
| Refund override control                      | C-40                             | 4.3                                                                |
| No-show retention by policy only             | C-41                             | 4.1 (no-show row), 11.6 (the no-show action)                       |

Controls C-25 to C-41 come from the threat-model addendum ([#354](https://github.com/ahliweb/awcms-one/issues/354)). The section references in the right-hand column are the nearest sections that carry each behaviour; the table is a traceability aid and the control text in the threat model is authoritative.

## Implementation status of Surface A (issue #386)

Built, in the `toko` profile only (`apps/storefront/src/profil/toko/pages/**`; a `berita` or `landing` build writes none of these pages and links to none of them), static (`output: "static"`, no `prerender = false`), reading the CMS from the browser:

| Page              | Reads (all `GET …/commerce/storefront/booking/*` unless noted)                                               | Does                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/booking`        | `offerings`, `availability`, `quote` (anonymous; an optional bearer prices the unit at the customer's level) | Service select, two native date inputs, guest count, the quote panel (nights, price per night, total, deposit and balance, all the server's strings), "Penuh" when no resource is free.                  |
| `/booking/pesan`  | `quote`, then `POST reservations` (bearer, `Idempotency-Key`), `GET reservations/{orderCode}` to re-sync     | Summary, payment choice, the hold and its countdown, the expired and confirmed states, the payment handoff (`POST …/orders/{code}/payment-gateway/sessions` with `purpose: deposit \| balance \| full`). |
| `/akun/reservasi` | `GET reservations` (bearer, keyset)                                                                          | The shopper's own reservations, newest first, with status and payment pills, the balance due, a live hold's remaining time and a pay button.                                                             |

Where it differs from the proposal above, and why:

1. **The hold is created on `/booking/pesan`, with the payment choice, not before it.** The server holds the stay and creates the order in one call that already needs the payment method (ADR-0045 G2), so "Lanjut" on `/booking` carries the stay as `?o=&r=&in=&out=&n=` (ids and plain dates, never an amount) and the hold happens when the shopper confirms on `/booking/pesan`. The countdown starts there. The "Ubah tanggal" link releases nothing because nothing is held yet.
2. **An account is required to reserve (ground rule 7), and the guest block is not shown.** Signed out, the page sends the shopper to `/masuk?kembali=` and back. The server also accepts a guest checkout (G15) but the storefront does not offer it; the stay's contact is the account's, shown read-only, because the server ignores a `guest` block when a bearer is presented.
3. **No hold extension.** The CMS has no extension endpoint, so the one-minute threshold shows a note ("Waktu tahan tidak dapat diperpanjang...") and the way to start again instead of a "Perpanjang waktu tahan" button (decision 2 in section 10 stays open).
4. **No calendar grid.** The two native date inputs are the complete control; the grid is an enhancement over them and is not built.
5. **No check-in and check-out times.** The availability and quote reads do not carry them (they are guest-information fields of the resource, not part of the overlap test).
6. **Resources are probed by id.** A Booking offering does not fix a resource and the offering link carries none, so `offerings` lists the ids of the tenant's active resources of the offering's mode and the page asks `availability` for each in turn, using the first with a free unit. A tenant selling several room types from separate resources of one mode would see every type offered under every offering; an explicit offering-to-resource assignment is a follow-up (ADR-0045 implementation notes for #386).
7. **The provider returns to `/pesanan`.** The gateway's finish URL is the CMS's `COMMERCE_STOREFRONT_PUBLIC_URL` plus `/pesanan`, so a shopper paying through the gateway lands on the order tracking page; `/booking/pesan` (same stay, same tab) and `/akun/reservasi` show the confirmed reservation and the remaining balance, and never claim "confirmed" from a redirect.
8. **The countdown never trusts the device clock.** Every reservation body carries `serverNow`; the remaining time is `holdExpiresAt - serverNow` minus the time elapsed on the device's monotonic clock, and the page re-asks the server at zero, when it regains visibility or the network, and every few seconds while held.

## 10. Decisions not recorded (assumptions to confirm)

1. **Check-in with an unpaid balance**: resolved by [ADR-0045](adr/0045-booking-commerce-adapter.md) D19. A tenant setting `checkin_requires_settlement` (default `true`: blocked until the balance is paid; `false`: allowed, balance stays visible) is enforced by the server with `BALANCE_NOT_SETTLED`; section 5.1 shows both variants. Issue #383 flipped the recommended default from allow to block (fail closed); the owner confirms it before that issue merges. Turning the setting from `true` to `false` on the commerce settings screen asks for the authenticator code (the shared step-up dialog) and every change is audited.
2. **Hold length and the extension rule**: the countdown shows whatever the server sets; the 15-minute figure in copy is illustrative, and whether one extension is allowed is a Booking/adapter decision.
3. **Guests/units stepper and multi-unit stays**: a stay is on one unit in v1 (upstream `awcms` ADR-0135 section 4); multi-room bookings are not specified here.
4. **Route names** are proposals; the phase-1 implementer fixes them and updates [`routing.md`](routing.md) and the profile matrix in the same change.
5. **Alternative-date suggestions** in the no-availability state depend on an availability endpoint capability that is upstream's to define.
6. **Whether the guest sees the late-payment exception contact** (3.2) as a phone, WhatsApp or e-mail is the tenant's configuration.
7. **Unknown-until-built**: all pixel-level design (spacing, the exact calendar visual) is the redesign design system's ([`ui-ux.md`](ui-ux.md)); this spec states behaviour, not a mock-up.

## 11. Surface E — admin screens of the booking adapter (Issue #385, DoR residual R2)

Written 17 October 2026. This is the spec that [#385](https://github.com/ahliweb/awcms-one/issues/385) owed before building (DoR residual R2); [#381](https://github.com/ahliweb/awcms-one/issues/381) builds the cancellation-policy and refund-override surfaces against it. The screens are `apps/cms` admin pages inside the `commerce` module (ADR-0045), behind the tenant's `booking` feature (default OFF) with `requiredFeature: { moduleKey: "commerce", feature: "booking" }` on every sidebar entry. Admin copy follows the repo's i18n rule: English is the msgid, Indonesian is in `id.po`; the Indonesian lines below are the catalogue translations. Every control is UX-only: the server re-validates every field and is the authority.

| Screen                            | Route                               | Permissions (view / change)                                                                | Built in                    |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| 11.1 Offering links               | `/admin/commerce-booking-links`     | `commerce.booking_offering_links.read` / `.create`, `.update`                              | #385                        |
| 11.2 Deposit policies             | `/admin/commerce-booking-deposits`  | `commerce.booking_deposit_policies.read` / `.update`                                       | #385                        |
| 11.3 Service-account setting      | `/admin/commerce-settings`          | `commerce.settings.read` / `.update` (existing screen, one new field)                      | #385                        |
| 11.4 Cancellation policy versions | `/admin/commerce-booking-policies`  | `commerce.booking_cancellation_policies.read` / `.create`, `.approve`                      | #381 (needs its policy API) |
| 11.5 Refund-override dialog       | on the order and reservation detail | `commerce.booking_refund_overrides.approve` (separate from the ordinary cancel permission) | #381 (needs its cancel API) |

All five use the shared states of section 1.1, adapted to the admin chrome: a denied viewer gets a `.state-notice`, a load failure a `.state-notice` with a retry hint, an empty list the `.empty-state` block with the next action, and a write failure a `role="alert"` box above the form (`.admin-create-error`). A busy button is disabled and relabelled ("Saving…"); the page reloads after a successful write (the existing `mutateAndReload` idiom), so the server's row is what the operator sees next.

### 11.1 Offering links

Purpose: link one Booking offering to one **service** product so the product can be sold as a reservation (ADR-0045 D1). One active product per offering and one active offering per product.

- **List.** A `.data-table-scroll` region (focusable, named) with a `<caption>` count. Columns: Offering (id, `.cell-code`), Product (id), Basis ("Per night" / "Per booking"), Resources (the bound resource ids in `.cell-code`, or the words "All active resources" when the link names none), Status (`admin-status-pill`: Active = success, Unlinked = neutral; text always present), Linked on, Actions. The list is keyset-paged (50), newest first; a "Show unlinked" filter is a plain GET link (`?status=unlinked`), not script.
- **Create form** (only with `.create`): Offering ID (uuid text, `autocomplete="off"`, hint "Copy it from Booking, Offerings."), Product ID (uuid text, hint "A service product."), Basis (select: Per night / Per booking), Resource IDs (optional, issue #437: uuids separated by commas, at most ten, hint "The room type this offering sells: copy the resource IDs from Booking, Resources, separated by commas. Leave empty to offer every active resource of the same kind."; sent as `resourceIds`, omitted when empty). Required fields are marked in text. The submit sends `POST` with a fresh `Idempotency-Key` per attempt.
- **Unlink** (only with `.update`): a row button opens the shared confirm dialog (danger). The dialog says what happens: the link stops being sellable; past orders and reservations keep their history; it cannot be re-linked from the same row (create a new link).
- **Warnings.** A created link whose product has no active cancellation policy shows a polite status line beside the form: "Linked. This product has no cancellation policy yet, so guests will see no refund terms." (`NO_CANCELLATION_POLICY`; non-blocking, ADR-0045 D6).
- **Server refusals are mapped to specific copy**, never the generic failure:

| Code                                   | English                                                         | Indonesian                                                                    |
| -------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `OFFERING_ALREADY_LINKED`              | This offering is already linked to a product.                   | Penawaran ini sudah ditautkan ke produk.                                      |
| `PRODUCT_ALREADY_LINKED`               | This product is already linked to an offering.                  | Produk ini sudah ditautkan ke penawaran.                                      |
| `PRODUCT_NOT_SERVICE`                  | Only a service product can be linked.                           | Hanya produk jasa yang dapat ditautkan.                                       |
| `QUANTITY_BASIS_MISMATCH`              | The basis does not match the offering (nightly or per booking). | Dasar kuantitas tidak sesuai dengan penawaran (per malam atau per pemesanan). |
| `OFFERING_NOT_LINKABLE`                | An offering that confirms immediately cannot be sold.           | Penawaran yang langsung terkonfirmasi tidak dapat dijual.                     |
| `BOOKING_SERVICE_ACTOR_NOT_CONFIGURED` | Set the booking service account in Store settings first.        | Tetapkan akun layanan pemesanan di Pengaturan toko terlebih dahulu.           |
| `FEATURE_DISABLED`                     | Booking is turned off for this store.                           | Pemesanan dimatikan untuk toko ini.                                           |
| `RESOURCE_NOT_FOUND`                   | The offering, the product or a resource was not found.          | Penawaran, produk, atau resource tidak ditemukan.                             |
| `RESOURCE_MODE_MISMATCH`               | A resource does not match the offering (stay or time slot).     | Resource tidak sesuai dengan penawaran (menginap atau slot waktu).            |
| `RESOURCE_NOT_ACTIVE`                  | A resource is inactive. Choose an active one.                   | Resource tidak aktif. Pilih yang aktif.                                       |

### 11.2 Deposit policies

Purpose: set a service product's deposit as a percent of the taxed line total or a fixed amount per unit of quantity (per night for a nightly product), or return it to full payment. A product without a policy is paid in full; there is no tenant default (ADR-0045 D5).

- **List.** One row per service product: Product (name, SKU), Status, Policy (text: "Full payment", "30.00% of the total", "Rp 50.000,00 per unit"), Actions. A `details` "Edit deposit" per row (only with `.update`) holds the form; the summary is the keyboard-reachable disclosure.
- **Form.** A fieldset "Deposit" with radios (Full payment / Percent / Fixed amount per unit); the Percent field (0-100, two decimals) and the Fixed field (amount, two decimals) are shown only for their radio, and hidden fields are removed from the tab order. The submit sends `PUT` with `{ kind, percent | fixedAmount }`; it never sends a computed amount. A line under the form states: "The deposit on each order is calculated by the server and fixed when the order is created; changing this does not change existing orders."
- **Allow-DP note.** Because the policy keeps the legacy "allow down payment" flag in step, the row shows no separate toggle; the product form's own control is locked by the server while `booking` is on (`ALLOW_DP_MANAGED_BY_POLICY`), and the screen says so in a hint.
- Validation copy: "Enter a percentage between 0 and 100 with at most two decimals." / "Enter an amount greater than zero with at most two decimals." (id: "Masukkan persentase antara 0 dan 100 dengan paling banyak dua desimal." / "Masukkan jumlah lebih besar dari nol dengan paling banyak dua desimal.").

### 11.3 Service-account setting

One field on the store-settings form, in its own legend "Booking": "Booking service account (user ID)" (id: "Akun layanan pemesanan (ID pengguna)"), a uuid, with the hint "The staff user Booking records for guest checkouts and automatic actions. It must be an active user of this store. Leave blank to clear it." It is rendered only while the `booking` feature is on and only for a viewer who can read settings; it is submitted with the existing save bar and sends `bookingServiceTenantUserId` (a uuid, or `null` to clear). An inactive or foreign user is refused by the server with a field error, shown in the form's error box.

### 11.4 Cancellation policy versions (specified here, built by #381)

> **Built** by [#381](https://github.com/ahliweb/awcms-one/issues/381) as `/admin/commerce-booking-policies`; sections 11.4 and 11.5 were followed, with two decisions: a draft is never edited (an edit is a new draft, since the windows table is insert-only), and the confirm and the step-up are native `<dialog>`s.

Purpose: author the windows of section 4.1 as **versions**: a draft is edited, approved by a second person, and only then becomes the active version; earlier versions stay readable and never change, so every refund can be explained by the version that applied.

- **Scope selector.** "Tenant default" or one product. The page shows the **active version** as the section 4.1 table, then **Draft** (editable, with `.create`), then **History** (a read-only `.data-table-scroll` table: version number, scope, approved by and on, windows summary, status pill). History rows have no edit or delete control (absent, not disabled).
- **Windows editor.** Rows of "Cancel at least [n] [hours|days] before check-in" and "Refund [0-100]%". Rows must be ordered and non-overlapping; the form states the rule and the server enforces it. A last row for "no-show" refunds at most what the policy says.
- **Approve** (`.approve`, a different person from the author - separation of duties, C-11): the button opens the confirm dialog showing the windows side by side with the active version.
- States: loading, empty ("No cancellation policy yet. Guests will see no refund terms."), error, success - as section 1.1.

### 11.5 Refund-override dialog (specified here, built by #381)

Purpose: the staff action of section 4.3, on the order detail and the reservation detail, for a reservation the policy does not refund as staff intend. This is the contract #381 builds to.

- **Visibility.** The control "Override refund" is absent (not disabled) without `commerce.booking_refund_overrides.approve`. It is also absent when nothing was paid.
- **Dialog.** A native modal `<dialog>` (the shared pattern: focus enters, Escape cancels, focus returns to the opener, background inert) named "Override the refund" and described by its figures. Rows: Paid (read-only), Policy refund (read-only, computed by the server), New refund amount (number, `min` 0, `max` = amount paid, `step` 0.01, `inputmode="decimal"`), Reason (textarea, required, minimum 10 characters, counter announced politely).
- **The cap.** The hint reads "Maximum Rp X: the amount paid." (id: "Maksimal Rp X: sebesar yang sudah dibayar."). The submit button is **disabled while the amount is above the amount paid, below zero, malformed, or the reason is too short**, and the field carries `aria-invalid="true"` with its message; the input's own `max` is a convenience only. **The server enforces the same bound** and refuses a larger amount with `REFUND_EXCEEDS_PAID` (409), shown in the dialog's alert; a hand-built request gets the same refusal.
- **Step-up.** Submitting triggers step-up re-authentication; the override is recorded only after it succeeds. A failed or abandoned step-up changes nothing and the dialog stays open with the typed values.
- **Copy.** Title "Override the refund" (id: "Ubah jumlah pengembalian dana"); confirm "Record the override" (id: "Catat perubahan"); cancel "Keep the policy amount" (id: "Pakai jumlah sesuai kebijakan", default focus); success status "Refund set to Rp X. The change is recorded with your reason." (id: "Pengembalian dana ditetapkan Rp X. Perubahan dicatat beserta alasan Anda."). The guest never sees the reason or the actor (section 4.3).
- **States.** Loading (figures not yet loaded: fields disabled, `aria-busy`), error (preview failed: retry, submit disabled), and success (dialog closes, the detail reloads and shows the recorded refund and an "Adjusted" pill).

### 11.6 Reschedule and no-show on the booking panel (built by #382)

Purpose: the staff actions of sections 4.3 on the order detail of a booked order: move the reservation to new dates (with the price difference carried by the order and refund paths), and mark a guest who did not arrive. Both live on the booking panel of section 11.5 (`CommerceBookingPanel`), behind the `booking` feature.

- **Reschedule - visibility.** The button "Reschedule" is absent (not disabled) without `commerce.booking_reservation_links.update`, and once the reservation is no longer confirmed or already has a decision.
- **Reschedule - dialog.** A native modal `<dialog>` named "Reschedule the reservation", described by the current dates ("Currently 2026-12-10 to 2026-12-12 (2 nights). The price of any difference is worked out by the server, never typed here."). A stay shows "New check-in" and "New check-out" date inputs; a time slot shows "New start (UTC)". A "Reason" select offers a closed list (the guest asked to move, the property needs to move it, double booking, another reason). The earliest date comes from the server's clock (`serverNow`), one day earlier than its UTC date because a resource's local date can trail UTC.
- **The price is the server's.** "Check the price" is disabled until the dates are valid (real dates, check-out after check-in, not in the past, not the current dates) and then asks `GET .../reschedule-quote`; the answer is shown as one sentence in a polite live region: same length ("nothing is priced; only the reservation moves"); a longer stay ("the extra nights are billed as a separate order of Rp X, which the customer pays like any order"); a shorter stay ("the removed nights are worth Rp X; the original cancellation policy refunds Rp Y, queued under Returns and refunds", or "refunds nothing", or "no cancellation policy applied"). The browser computes no figure and sends none: the POST body is the new time and the reason code.
- **Submit.** "Reschedule" posts with an `Idempotency-Key`; the page reloads on success and shows the new reservation and one row of the history. A refusal is shown in the dialog in words: the dates are not available (`SLOT_UNAVAILABLE`), a shorter stay on an unpaid balance (`BALANCE_OUTSTANDING`), nights that were sold on another order (`REDUCTION_NOT_SUPPORTED`), the extra nights cannot be sold (`SUPPLEMENT_ORDER_UNAVAILABLE`), and the rest.
- **History.** A "Reschedules" table (`.data-table-scroll`, `data-table--stack`): when, nights before and after, the difference (same length, longer stay, shorter stay), the priced and refund amounts, and the extra order with its code (a link to that order), status and total.
- **No-show - visibility.** The block "The guest did not arrive" appears for a confirmed reservation whose original arrival has passed, for a viewer who holds both the cancel and the decision key. It shows the policy applied, the no-show rule (keep the deposit, keep everything paid, refund by the windows), what was paid and what the policy keeps.
- **No-show - action.** "Mark no-show" opens the shared confirm dialog, which states the figures and that nothing is refunded; Booking decides whether the arrival plus the grace has elapsed (`NO_SHOW_TOO_EARLY` is shown as "Too early..."). After the decision, the panel shows "No-show decision" with "Kept by the policy" and "No money moves: a no-show is never refunded."
- **States.** Quote loading ("Checking the price..."), quote error (in the dialog, submit still available), and success (reload).

### 11.7 Accessibility, keyboard and 360px for these screens

The floor of section 6 applies; in addition:

- **Keyboard.** Every control is reachable in reading order: filter link, create form, table region (focusable, named), row buttons, `details` disclosures; Enter and Space operate buttons and summaries; the confirm dialog traps focus, Escape cancels, and focus returns to the row's button. No pointer-only affordance exists.
- **Names and status.** Each input has a visible `<label>` bound by `for`/`id`; hints are tied with `aria-describedby`; a status pill always carries its text; an error is a text message in a `role="alert"` region, never colour alone.
- **No raw browser dialogs.** Destructive confirmations use the shared `CommerceConfirmDialog`; `window.confirm`, `alert` and `prompt` are forbidden (the admin gate fails otherwise).
- **360px.** Tables use `data-table--stack` with `data-label` on each cell, inside the `.data-table-scroll` region; forms are one column with 44px controls; the page never scrolls horizontally; long ids wrap (`overflow-wrap: anywhere`).
- **Verification.** The axe `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` scan and the 360px overflow check cover the screens that exist (11.1 to 11.3); 11.4 and 11.5 join them when #381 builds them.
