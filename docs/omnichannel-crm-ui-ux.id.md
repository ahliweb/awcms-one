🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](omnichannel-crm-ui-ux.md)

<!-- i18n-source-hash: sha256:e7b1694515f521d7c470b94ed9764843ef2c0a06c787ef0ec24b1fda0ee94776 -->

# AWCMS-One Omnichannel CRM — Spesifikasi UI/UX lengkap v1.0

**24 Oktober 2026 — standar desain USULAN, bukan bukti semua layar tersedia.** Issue [#472](https://github.com/ahliweb/awcms-one/issues/472). Sumber kondisi aktual: [status](status.id.md), [CMS](cms.id.md), [PRD Business](aw-business-platform-prd.id.md), [standar CRM PR #465](https://github.com/ahliweb/awcms-one/pull/465), [runtime Bun PR #468](https://github.com/ahliweb/awcms-one/pull/468).

## 1. Keputusan dan bukti implementasi

- **Sudah berjalan di commerce:** Astro /admin/commerce-customers, /admin/commerce-segments, /admin/commerce-campaigns, /admin/commerce-inbox, /admin/commerce-whatsapp, /admin/commerce-reports, /admin/commerce-settings, order, booking dan POS. Feature flag/izin tetap berlaku. Inbox commerce tidak identik dengan inbox lintas sosial.
- **Sudah berjalan di upstream AWCMS:** modul email, template, newsletter, suppression, WhatsApp generik, Web Push, Telegram notifikasi staf dan halaman /admin/omes/* sesuai kontrak yang ada. Port social publishing belum menjamin adapter akun provider nyata.
- **Direncanakan:** lead/pipeline [AWCMS #1163/#1166](https://github.com/ahliweb/awcms/issues/1166), unified inbox/SLA [#1144/#1164](https://github.com/ahliweb/awcms/issues/1164), follow-up [#1165](https://github.com/ahliweb/awcms/issues/1165), multi-akun/sosial [#1139–#1152](https://github.com/ahliweb/awcms/issues/1139), CRM campaign [One #458](https://github.com/ahliweb/awcms-one/issues/458), AI Hermes [#459](https://github.com/ahliweb/awcms-one/issues/459), Telegram [#460](https://github.com/ahliweb/awcms-one/issues/460), Mailketing [#461](https://github.com/ahliweb/awcms-one/issues/461), mapping lead/customer [#463](https://github.com/ahliweb/awcms-one/issues/463), laporan [#464](https://github.com/ahliweb/awcms-one/issues/464).
- **Versi faktual (24 Oktober):** root AWCMS/AWCMS-One Bun **1.4.3**, Astro Bun **1.4.2**; stabil terbaru terverifikasi **1.4.4** (22 Oktober). Mailketing adapter masih memakai **v1**; target **REST v2.0.2** (23 Oktober). Issue AWCMS #1159 migrasi, #1172 Bun, One #470, Astro #125. Layar v2 harus bertanda belum aktif sampai backend teruji.
- **Kebijakan terbaru yang aman:** tinjau bun outdated, bun audit, SDK, image, perubahan provider setiap minggu; update menjadi PR pin-versi, uji, staging dan rollback. Jangan tag produksi latest atau edit bun.lock manual. Issue dependensi AWCMS #1173, One #471, Astro #126, OMES #347.

## 2. Batas arsitektur dan prinsip desain

**Gunakan token dan komponen admin Astro AWCMS yang sudah ada**, termasuk stat-card, status-pill, segmented, filter-bar, two-pane, timeline, toggle dan media-grid. Mendukung terang/gelap, bahasa Indonesia/Inggris, WCAG AA dan status tanpa ketergantungan warna. **Jangan membangun admin React/Node, customer master, queue maupun database analitik baru**. AWCMS menguasai tenant, RBAC/ABAC/RLS, channel dan pengiriman; commerce menguasai customer, segmen dan kampanye; produk turunan menguasai proses bisnis khusus.

StarSender boleh menjadi **default khusus tenant produk LPP ENTER**, Meta Cloud API menjadi pilihan alternatif; template umum tidak mempunyai default StarSender global. Tampilkan risiko penggunaan StarSender yang bukan API resmi. Perubahan provider hanya untuk pekerjaan antrean baru, tanpa fallback diam-diam atau rotasi perangkat untuk mengakali kebijakan.

Broadcast **bukan WebSocket**: event→outbox tahan lama→dispatcher **Bun**→HTTPS provider→status terverifikasi→audit. SSE Bun satu arah lebih sesuai untuk progres dashboard; WebSocket native Bun hanya untuk kebutuhan dua arah setelah ADR #1168 diterima. Gateway generik #1171 belum dibangun. Notifikasi browser tertutup memerlukan opt-in Web Push yang terpisah. OMES host worker Python outbound HTTPS dan runtime native Hermes tidak perlu diganti.

Semua informasi tergantung izin tenant/brand, tujuan/consent dan suppression. Tidak boleh menampilkan token, OTP, pesan privat atau data antar-tenant. Diterima provider tidak selalu delivered; stale/unknown bukan success.

## 3. Struktur navigasi dan pengguna

Sidebar: **CRM** (Overview, Leads, Customers, Pipelines, Inbox, Follow-up, Segments, Campaigns); **Channels** (Accounts, WhatsApp Numbers, Email/Mailketing, Telegram, Social Publishing, Website Forms); **Analytics** (Funnel, Attribution, Staff SLA, Delivery Logs); **Automation** (Rules, AI Assist, Knowledge, Approvals); **System** (Roles, Audit, OMES Control Center, Service Health).

Header berisi tenant/brand berizin, breadcrumb, search, status sinkron, notifikasi dan akun. Rute yang belum ada **tidak boleh menjadi link aktif palsu**. Owner mengatur kebijakan, admin marketing menghubungkan kanal/menyetujui kampanye, operator membuat draf, staf CS menangani thread, analis melihat laporan berizin, Hermes hanya mengusulkan aksi, pengunjung hanya melihat form/akun sendiri. Pergantian tenant harus menghapus cache dan langganan realtime yang lama.

## 4. Inventaris layar lengkap dan status

| ID | Layar | Status | Penanggung jawab |
| --- | --- | --- | --- |
| UX-01 | Customer commerce | Sudah ada | commerce |
| UX-02 | Segmen commerce | Sudah ada, feature-gated | #360/#362 |
| UX-03 | Kampanye commerce | Sudah ada, feature-gated | #114 |
| UX-04 | Inbox commerce | Sudah ada, terbatas | #111 |
| UX-05 | WhatsApp commerce | Sudah ada, legacy/upstream | ADR-0047/#449 |
| UX-06 | Laporan/dashboard/booking/POS | Sudah ada | docs/cms.md |
| UX-07 | Admin email/suppression/newsletter/WhatsApp upstream | Sudah ada sesuai izin | AWCMS |
| UX-08 | OMES Admin /admin/omes/* | Sudah ada sesuai izin | OMES #200/#201 |
| UX-09 | Dashboard funnel lead dan CRM | Rencana | One #464 |
| UX-10 | Leads, intake, dedup, detail | Rencana | AWCMS #1166/One #463 |
| UX-11 | Pipeline/kanban | Rencana | AWCMS #1163/#1166 |
| UX-12 | Unified inbox + SLA | Rencana | AWCMS #1144/#1164 |
| UX-13 | Channel Hub multi-akun dan OAuth | Rencana | AWCMS #1139/#1140/#1154 |
| UX-14 | StarSender multi-device & Meta multi-WABA | Rencana | AWCMS #1141–#1143 |
| UX-15 | Mailketing API v2.0.2 multiakun | Rencana; v1 masih aktif | AWCMS #1158–#1162 |
| UX-16 | Telegram multibot pelanggan dan channel | Rencana; Telegram staf ada | AWCMS #1155–#1157 |
| UX-17 | Facebook/Instagram Professional | Rencana | AWCMS #1146 |
| UX-18 | TikTok/LinkedIn/YouTube/Threads | Rencana/riset hak API | AWCMS #1148–#1151 |
| UX-19 | Kalender publikasi sosial | Rencana | AWCMS #1145–#1152 |
| UX-20 | Website lead form dan consent | Rencana CRM; website ada | Astro #127 |
| UX-21 | Preview segmen, CSV, dedup | Parsial | One #458/#461 |
| UX-22 | Kampanye lintas-kanal dengan approval | Parsial | One #458/#461 |
| UX-23 | Progres broadcast dan realtime | Parsial; SSE/WS belum ada | AWCMS #1168/#1171 |
| UX-24 | Worklist follow-up dan workflow | Rencana | AWCMS #1165 |
| UX-25 | AI Copilot/Knowledge/Approval | Rencana | One #459/OMES #343/#344 |
| UX-26 | Analitik konversi/atribusi/SLA | Parsial | One #464 |
| UX-27 | Notification Center dan Web Push customer | Parsial | One #430–#432 |
| UX-28 | OMES AI/Mission Control | Parsial read-only, kelola AI rencana | OMES #263/#343/#344 |
| UX-29 | Diagnostik koneksi, webhook dan audit | Parsial | AWCMS #1154/#1161 |
| UX-30 | Status versi/dependency dan kesiapan rilis | Rencana diagnostik | AWCMS #1172/#1173, One #470/#471 |

## 5. Wireframe dan pola tampilan

Desktop ≥1200px: sidebar ±240px, header tenant/brand, judul, status freshness, filter, kartu KPI/tabel/drawer, grid 12 kolom dan konten maksimal sekitar 1440px. Tablet 768–1199px: sidebar collapsible, dua kolom kartu dan filter lipat. Ponsel <768px: satu panel, detail sebagai halaman/drawer, CTA jelas, label tabel dan scroll aksesibel. Ukuran tersebut **usulan**, perlu dicocokkan dengan token CSS upstream.

Semua layar harus mempunyai empty/loading/error/permission denied/stale/unknown state. Loading bukan nilai nol. Aksi gagal memberi penyebab dan retry aman; aksi destruktif memerlukan konfirmasi, fokus keyboard dipulihkan, toast dan log tidak membocorkan data. Filter dapat disetel ulang dan status tabel dapat diakses screen reader.

## 6. Kontrak detail setiap layar

**UX-09 Dashboard CRM:** KPI lead baru/dihubungi/qualified/follow-up/registrasi/konversi, median respons dan eligible audience; filter tenant/brand/periode/zona waktu/channel/owner; funnel dengan denominator/version; chart memiliki tabel aksesibel. Klik kartu membuka daftar yang tetap diautorisasi. Webhook hilang = unknown, tidak dihitung delivered.

**UX-10/11 Leads & Pipeline:** tabel kontak tersamarkan, sumber, kampanye/UTM, owner, stage, due, consent dan duplikat. Detail Overview/Timeline/Conversations/Tasks/Consent/Audit. Aksi create/assign/tag/move stage/link customer harus punya bukti dan optimistik revision. Kanban memiliki alternatif keyboard. Tahap program/angkatan LPP adalah konfigurasi, tidak di-hard-code.

**UX-12 Unified Inbox:** panel kiri filter akun, Mine/Unassigned/Team/Overdue, daftar pesan/SLA; kanan transkrip, internal note, lampiran berizin, quick reply, composer, assignment dan saran AI. Ponsel daftar→detail. Reply hanya aktif bila kemampuan provider, jendela, sender dan consent sah; error konflik saat dua agent membalas mencegah double-send.

**UX-13 Connections Hub:** daftar akun provider, alias, tenant/brand, capability publish/reply/dm/lead_ads/analytics, token expiry, sender dan health. Wizard provider→OAuth/API token server-side→verifikasi kepemilikan→cek capability→izin brand→risk acknowledgement→default. Disconnect memperingatkan pekerjaan antri. Akun connected tidak menjamin semua DM/fitur tersedia.

**UX-14 WhatsApp Manager:** banyak StarSender device dan Meta WABA/phone ID; alias, nomor masked, kesiapan, kuota, risiko, waktu verifikasi. LPP tenant StarSender default setelah persetujuan risiko; Meta alternatif eksplisit. Template Meta yang disetujui tidak diterapkan palsu ke StarSender. Pergantian default hanya untuk pesan berikutnya; tidak ada fallback tersembunyi, rotasi anti-spam, atau klaim delivered tanpa bukti.

**UX-15 Mailketing v2:** indikator target **v2.0.2** dengan banner v1 aktif sampai cutover; sender/domain verified, kredit, last sync, akun/brand, mapping segmen/list, status subscriber. UI hanya memakai API terdokumentasi **POST /send, GET /credits, GET /senders, GET /lists, POST /subscribers**. Remote campaign CRUD/unsubscribe tidak dipalsukan. Provider **selalu membuat message_id** v2.0.2; tampilkan terpisah dari queue ID internal, provider accepted bukan delivered. 401 token, 402 kredit, 403 sender, 422 input, 429 Retry-After, 5xx retry dan webhook trust bermasalah memiliki status yang jelas.

**UX-16 Telegram:** bot/channel nickname, masked ID, admin rights, webhook, kemampuan chat, token dan status. Telegram staf yang ada **tidak sama** dengan engagement pelanggan; tidak ada pesan bot tanpa izin/interaksi sah. Remove rights langsung menonaktifkan aksi.

**UX-17–19 Social & Calendar:** capability matrix Facebook/IG Professional, TikTok, LinkedIn, YouTube, Threads dan provider fase berikutnya. Jangan menampilkan DM YouTube atau enrichment LinkedIn sebagai kemampuan umum. Pilih banyak akun/brand, kalender Day/Week/List, preview konten/caption/aspect ratio, alt text/lisensi, draft→review→approve→schedule→publish/error. Simpan posting ID/URL dari provider, jelas saat izin tidak tersedia.

**UX-21–23 Campaign Composer:** segmen commerce berversi dan sampel masked; preview audience mengecualikan consent/suppression; wizard Goal→Channel→Sender→Audience→Template→Policy→Test→Approval→Schedule→Review. Tampilkan jumlah eligible, estimasi kredit bila tersedia, beda queued/provider accepted/verified delivered/unknown/failed/suppressed/replied/converted. Cancel hanya pekerjaan belum terkirim; worker Bun memakai HTTPS provider, SSE/WS Bun hanya progres UI jika sudah disetujui.

**UX-24 Follow-up:** daftar Today/Due/Overdue/Waiting/Completed, zona waktu/jam kerja, owner dan SLA. Rule builder WHEN event → IF consent/stage/izin → THEN task/draf/schedule berizin. Simulasi/versioned rules dan emergency stop; reply, convert, unsubscribe dan blocked sender membatalkan pengiriman berikutnya.

**UX-25 AI Copilot:** panel thread/lead, mode Assist default/Limited Auto FAQ aman/Escalate. Tampilkan knowledge sumber, versi/masa berlaku, bukti kutipan, biaya, status manusia Approve/Edit/Reject. Tidak boleh berhalusinasi harga/jaminan kerja, membaca secret atau menjalankan tool lewat prompt injection. Hermes memproses saran, AWCMS memutuskan kebijakan, OMES memantau host.

**UX-26 Reporting:** hitung funnel dan attribution dari fakta valid, pembilang/penyebut/lookback eksplisit, SLA normalisasi jam kerja dan beban staf, export berizin dan perlindungan PII/CSV formula. Reuse reporting engine, status tidak tersedia = unknown, bukan nol.

**UX-27 Notifications:** preferensi email/WhatsApp/Web Push per purpose, bukti opt-in dan opsi cabut. PWA iPhone menjelaskan instalasi bila diperlukan; izin browser diminta setelah tindakan user. Pusat operator untuk pesan baru, follow-up telat, campaign gagal, kredit/akun kedaluwarsa dengan quiet hours/dedup. Browser tutup bukan WebSocket tetap hidup.

**UX-28 OMES:** gunakan desain OMES yang sudah diadopsi. Tree host/sesi/subagent, provenance/freshness, budget/policy, approval typed API, bukan shell atau memori rahasia Hermes. Bedakan online/stale/unknown; Mission Control 3D rencana harus memiliki mode 2D aksesibel.

**UX-29/30 Diagnostik:** akun disconnected, circuit breaker, webhook gagal, antrean tertunda, saldo, job Bun, versi runtime terpasang vs stable terbaru, umur dependency audit, versi provider API dan insiden. Pembaruan versi = cek changelog→issue/PR atomik→test→staging→promote→rollback. UI tidak menyediakan shell package update sembarangan dan tidak mengklaim semua dependency latest dari semver ^.

## 7. Alur end-to-end yang wajib diuji

**J1 Lead→konversi:** form terverifikasi → dedup dan attribution → assign → inbox eligible → respons disetujui manusia/AI → follow-up → konversi terverifikasi → KPI. Penolakan harus punya alasan.

**J2 Mailketing v2:** sender/domain terverifikasi dan kredit → segment immutable+consent → konten dan tes → approval → Bun email queue → Mailketing API v2.0.2 menghasilkan provider message_id → webhook tepercaya/reconciliation atau Unknown → laporan. Jika v1 masih aktif, tombol fitur v2 yang belum didukung wajib nonaktif.

**J3 WhatsApp dua provider:** default StarSender khusus produk LPP (risk acknowledged), pemilihan Meta alternatif jelas → validasi format masing-masing → queue Bun terikat sender → status provider yang benar. Tidak fallback otomatis.

**J4 Hermes:** thread berizin → konteks AI teredaksi → draf mengacu knowledge resmi → manusia menyetujui → AWCMS cek RBAC/consent/provider → Bun queue → pembaruan status berizin. OMES tidak mendapat listener inbound privileged.

## 8. Acceptance, a11y dan keamanan

| Area | Acceptance |
| --- | --- |
| Keyboard & WCAG | Fokus dan Escape modal, alt kanban keyboard, kontras WCAG 2.2 AA, status tidak hanya warna |
| Mobile | 360–390px, target sentuh, drawer dan detail navigable, bukan tabel terpotong |
| Tenant | Pergantian tenant menghapus cache/subscription; cross-tenant/brand harus ditolak server |
| Broadcast | Consent bukan berasal dari CSV/list; opt-out sebelum send; approval dan idempotency |
| SSE/WS | Origin, tiket singkat, role revoke, topic leak, backpressure, reconnect, snapshot |
| Provider | 401/402/403/422/429/5xx, akun diblokir, token expired, delivery unknown |
| AI | Prompt injection, claim tanpa knowledge, PII egress, approval, audit, emergency stop |
| Data & ekspor | PII masked, retention/DSR, CSV formula aman, audit trail, tidak ada secret di log |
| Kinerja | Paginasi, error/empty/loading akurat, a11y chart table, JS/asset budget |
| Release | Bun versi stabil kompatibel dipin, library audit, rollback, toko/berita/landing/template:init |

## 9. Standar handoff desain dan rilis

Setiap issue layar memuat **UX ID, route/bukti kode, issue owner, referensi Figma bila tersedia, role/permission, DTO, validasi field, state empty/loading/error/disabled, responsif, i18n, keamanan, tes dan screenshot sintetis**. Mockup bukan bukti backend sudah berjalan.

Gelombang: **P0** Bun 1.4.4 dan Mailketing v2.0.2 yang diuji, registry dan consent; **P1** lead, inbox, multi-sender; **P2** campaign/follow-up/atribusi; **P3** AI approval dan sosial; **P4** SSE/WS setelah ADR serta OMES/reporting. Semua code upstream AWCMS lebih dulu, sinkronisasi subtree AWCMS-One hanya **MERGE COMMIT**, semua profil dan RLS diverifikasi.

**Rujukan eksternal:** [Mailketing API v2.0.2](https://api.mailketing.co.id/docs/), [webhook](https://api.mailketing.co.id/docs/webhook.html), [Bun 1.4.4](https://bun.com/blog/bun-v1.4.4), [bun outdated](https://bun.com/docs/pm/cli/outdated), [bun audit](https://bun.com/docs/pm/cli/audit), [bun update](https://bun.com/docs/pm/cli/update). Status versi harus diperbarui sebelum coding.
