[English (source)](openbot-hermes-reference-2026-11-25.md) · Bahasa Indonesia

# Evaluasi referensi OpenBot — AWCMS-One: CRM commerce dan persetujuan

## Metadata
- Version: v0.1.0
- Last updated: 2026-11-25
- Changeset: riset konsep independen dan penilaian gap awal.
- Status: usulan riset; bukan ADR diterima, implementasi, atau approval gerbang.
- Tracking: [#590](https://github.com/ahliweb/awcms-one/issues/590).

## Kesesuaian lokal
Lihat [status](status.id.md), ADR-0024 dan #459. Template commerce dengan subtree AWCMS; produk turunan memiliki backend, migrasi, secret dan data sendiri. Perubahan generik di upstream; tidak ada backend bersama atau salinan logika agent.

| Skenario | Batas |
|---|---|
| Triase pesan | proyeksi percakapan minimal yang diizinkan |
| Draft balasan | saran saja; manusia memilih isi dan kirim |
| Ubah pesanan/refund | izin commerce, otorisasi ulang/persetujuan, tanpa pembayaran langsung oleh agent |
| Webhook | sumber terverifikasi, idempotensi, jangan percaya LLM |
| Data pelanggan | scope tenant, minimisasi egress, retensi sesuai kebijakan |

Cek gap #459 dan ownership subtree. Uji tenant/customer salah, pesanan basi, mutasi duplikat, timeout provider, prompt injection pada chat masuk dan ekspor ditolak. UAT produk di downstream. Tanpa duplikasi modul, SDK, runtime atau perubahan produksi.

## Bukti dan keputusan, 25 November 2026

| Sumber primer | Temuan | Keputusan |
|---|---|---|
| [LICENSE Nightly Labs](https://github.com/nightly-labs/openbot/blob/main/LICENSE), [README](https://github.com/nightly-labs/openbot/blob/main/README.md) | PolyForm Noncommercial 1.0.0; workspace agent, koordinasi tim, integrasi provider termasuk Hermes ACP | Referensi konsep saja; tidak menggunakan kode, binary, skill, aset atau layanan proprietary |
| [PolyForm](https://polyformproject.org/licenses/noncommercial/1.0.0) | Izin riset personal dibatasi tidak adanya rencana penerapan komersial | Jangan memasang/menguji software terbatas untuk pengembangan komersial tanpa izin terpisah |
| [CopilotKit LICENSE](https://github.com/CopilotKit/OpenBot/blob/main/LICENSE), [konfigurasi](https://github.com/CopilotKit/OpenBot/blob/main/docs/configuration.md), [arsitektur](https://github.com/CopilotKit/OpenBot/blob/main/docs/architecture.md) | Template MIT; Intelligence perlu lisensi atau project key; default browser luas mengizinkan aksi | Konsep saja; tolak default permisif dan ketergantungan Intelligence |
| [Hermes](https://github.com/NousResearch/hermes-agent), [Kanban](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/kanban.md) | Repositori MIT; learning, skills, agent persisten, durable board | Pertahankan integrasi upstream yang disetujui; verifikasi versi terpasang sebelum duplikasi |

Klaim lisensi tag lama bukan bukti hak pakai; tidak ada versi historis yang diimpor. Dokumentasi publik bukan bukti keamanan, kesiapan produksi atau performa. Tidak ada instalasi, benchmark atau audit kode di sini. Periksa lisensi pada commit immutable, dependensi, model, aset dan layanan sebelum adopsi.

## Referensi industri independen

| Referensi | Peran |
|---|---|
| [ACP](https://agentclientprotocol.com/get-started/introduction) | Siklus sesi agent/client, negosiasi kemampuan, izin, pembatalan; bukan mesin otorisasi |
| [AG-UI](https://docs.ag-ui.com/introduction) | Interaksi agent/user berbasis event; proyeksi bertipe dan disanitasi |
| [MCP security](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) | Tool/konteks; cegah token passthrough, confused deputy, SSRF dan hasil tool berbahaya |
| [A2A](https://a2a-protocol.org/v1.0.0/) | Kolaborasi agent; identitas, audience, tujuan, expiry dan revokasi tetap wajib |
| [Temporal](https://docs.temporal.io/workflow-execution) | Referensi durable workflow, idempotensi dan rekonsiliasi; bukan keputusan dependensi |
| [OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) | Korelasi dan observabilitas; pin field stabil dan sanitasi |
| [OWASP Agentic Top 10 2026](https://genai.owasp.org/top-10-for-agentic-applications-2026/) | Pembajakan tujuan, penyalahgunaan tool/identitas, supply chain, eksekusi, poisoning, komunikasi, cascade failure, eksploitasi trust dan rogue agent |
| [NIST AI 600-1](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence) | Govern, map, measure, manage |
| [OpenChain](https://openchainproject.org/get-started), [SPDX](https://spdx.dev/), [CycloneDX](https://cyclonedx.org/) | ISO/IEC 5230, 18974; inventaris lisensi dan SBOM |

Diakses 25 November 2026. Lisensi spesifikasi dan SDK berbeda; dokumen ini tidak menyetujui SDK. Pin revisi dan uji interoperabilitas sebelum usulan dependensi.

## Usulan kontrol lintas sistem (bukan implementasi)

- Default-deny pada server/host: principal, tenant/domain, capability, resource, purpose; output agent bukan otorisasi.
- Aksi berdampak tinggi: preview, digest immutable, approver independen, expiry singkat, persetujuan sekali pakai terikat actor/action/target/version; otorisasi ulang sebelum eksekusi, tolak mismatch/revokasi.
- Profil worker terisolasi, scope minimal read-only, secret terpisah, egress allowlist, budget, cancellation dan emergency stop. Dokumen, web, hasil tool, skills dianggap tidak tepercaya.
- State durable milik pemilik workflow: queued/running/waiting_approval/succeeded/failed/cancelled/unknown; lease/fencing, retry terbatas, idempotency key dan rekonsiliasi efek eksternal; tidak menjanjikan exactly-once eksternal.
- Usulan audit: event_id, correlation_id, actor_ref, tenant_ref, capability, resource_ref, policy_version, decision, approval_ref, outcome, waktu; metadata disanitasi; retensi sesuai kebijakan, tanpa kredensial, secret mentah atau chain-of-thought.
- Usulan memory/skill: provenance, review sesuai scope, expiry/revokasi dan regression test; hormati otoritas native runtime.
- Uji sebelum produksi: isolasi tenant, persetujuan basi/replay, injection pada tool, egress, crash/restart, retry bersamaan, cancellation, memory korup, recovery dan audit. Bedakan dokumen, mock, unit test, integrasi nyata dan produksi.

## Lisensi dan tata kelola

Arahan pemilik: implementasi mandiri dari konsep relevan, tanpa menyalin source code, ekspresi dokumentasi, branding, aset layar atau skill OpenBot. Catat spesifikasi fungsional orisinal, provenance, URL/versi/lisensi, pohon dependensi, hak penggunaan komersial, SBOM, notice dan pengecualian. MIT/Apache/BSD kandidat, bukan persetujuan otomatis; copyleft dan source-available wajib review. Jangan mengasumsikan hak paten atau merek. UU 28/2014 (khususnya Pasal 41 tentang ide/ekspresi) dan UU 27/2022 memerlukan review hukum/privasi kontekstual: [hak cipta](https://peraturan.bpk.go.id/Details/38690), [PDP](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022).

Pemetaan kontrol: ISO/IEC 42001, 23894 (AI); 27001/27002/27005 (ISMS); 27017/27018 (cloud); 27034 (aplikasi); 27701 (privasi); 15408 (evaluasi sesuai scope); 20000-1 (layanan); ISO 22301 (kontinuitas); 5230/18974 (supply chain). Ini panduan, bukan sertifikasi. Tidak ada paket, runtime atau perubahan produksi sebelum ADR dan gerbang yang berlaku.

## Changelog
- v0.1.0 (2026-11-25): validasi dokumentasi publik, batas tanggung jawab, usulan uji.
