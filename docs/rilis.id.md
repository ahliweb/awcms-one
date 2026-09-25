🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](rilis.md)

<!-- i18n-source-hash: sha256:546b86963c37b583a33cdbbf9f4d90f5685aaa4a33c71675ea06812e3852f284 -->

# Runbook rilis

Jalur end-to-end dari changeset yang ditulis sampai image `apps/cms` yang ditandatangani dan dipublikasikan, serta GitHub Release — `bun run release`, lalu `bun run release:images -- --publish`, lalu `bun run release:publish`. Lihat [ADR-0023](adr/0023-release-images-are-built-signed-and-published-from-a-trusted-release-host.md) untuk alasan ini berjalan dari release host tepercaya ketimbang GitHub Actions, dan [ADR-0020](adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) untuk image mana yang dipublikasikan dan kenapa storefront tidak.

## Empat langkah, secara berurutan

### 1. `bun run release --apply --commit`

Tidak berubah dari sebelum ADR ini (`tools/rilis.mjs`) — melipat `.changesets/*.md` yang menunggu ke `CHANGELOG.md`, menaikkan `package.json`, commit, dan tag `vX.Y.Z`. Pratinjau dulu tanpa `--apply`; tidak ada yang ditulis sebelum itu.

### 2. `git push && git push origin vX.Y.Z`

Push tag ini yang menjadi kunci semua yang berikutnya. Push ke `origin` sebelum menjalankan dua langkah berikutnya — keduanya menolak berjalan terhadap tag yang belum mencapai `origin`.

### 3. `bun run release:images -- --publish --tag vX.Y.Z`

Membangun target `runtime` dan `jobs` milik `apps/cms/Dockerfile.production`, mem-push keduanya ke GHCR, menandatangani setiap digest yang ter-push, memverifikasi tanda tangan, memindai vulnerabilitas, mengekspor SBOM setiap image, dan menulis bundel bukti rilis. Menolak langsung kecuali **semua** berikut ini terpenuhi:

- working tree bersih (tidak ada perubahan uncommitted atau untracked);
- `HEAD` persis commit yang di-tag `vX.Y.Z`;
- commit itu adalah ancestor dari `origin/main` (fetch dijalankan dulu);
- `COSIGN_KEY` diset ke kunci penandatanganan nyata — alat ini tidak pernah membuat kunci begitu saja.

Environment yang wajib (terdokumentasi lengkap di root `.env.example`): `GHCR_USER`, `GHCR_TOKEN` (`write:packages` saja), `COSIGN_KEY`, `COSIGN_PASSWORD`, `COSIGN_PUBLIC_KEY`. Opsional: `--registry` (default `ghcr.io`), `--owner`/`--repo` (default: diparsing dari `git remote get-url origin`), `--trivy-severity` (default `CRITICAL`), `--evidence-dir` (default: direktori di bawah path temp OS, sengaja di luar working tree repositori ini).

Tanpa `--publish`, perintah yang sama hanya membangun — tidak pernah login, tidak pernah push, tidak pernah menandatangani. Ini mode PR/verifikasi; jalankan sebagai `bun run release:images` (tanpa perlu `--tag`, karena tidak ada yang membacanya di bawah) untuk membuktikan kedua target Dockerfile masih bisa dibangun dari tree saat ini.

**Jika trivy memblokir jalannya:** temuan `CRITICAL` menggagalkan rilis secara tertutup — baca `<evidence-dir>/<target>-trivy.json` untuk laporan lengkap. Dua jalan jujur ke depan, tidak ada yang ketiga: perbarui image dasar (`FROM oven/bun:...` milik `apps/cms/Dockerfile.production` sendiri, upstream — lihat aturan subtree AGENTS.md untuk siapa yang bisa mengubahnya) sehingga temuan itu benar-benar hilang, atau catat pengecualian berjangka waktu dan beralasan di `SECURITY.md` repositori ini sendiri dan jalankan ulang dengan `--trivy-severity` yang lebih sempit hanya untuk jendela CVE spesifik yang diterima. Jangan pernah menjalankan ulang dengan filter severity lebih lebar hanya agar rilis jadi hijau — itu menyembunyikan temuan, bukan menyelesaikannya.

Juga menjalankan smoke test Dockerfile storefront yang hanya build — `bun run release:images -- --storefront-smoke` (ketiga profil) atau `--storefront-smoke --profile toko` (satu), menggantikan job `storefront-smoke` milik `.github/workflows/images.yml`. Tidak pernah mempublikasikan apa pun (ADR-0020 D2/D3): ia hanya membuktikan `apps/storefront/Dockerfile` masih bisa dibangun terhadap stub CMS milik repositori ini sendiri.

### 4. `bun run release:publish -- vX.Y.Z --evidence <evidence-dir>`

Mengekstrak bagian `CHANGELOG.md` milik `vX.Y.Z`, menghitung apakah itu rilis tertinggi, dan membuat atau memperbarui GitHub Release yang cocok secara idempoten. Dengan `--evidence`, melampirkan JSON bukti, setiap SBOM yang diekspor, dan `SHA256SUMS` sebagai aset Release.

**Perhitungan `--latest` menyaring tag `awcms` upstream, bukan hanya lewat ancestry.** `git tag --list 'v*'` di checkout ini mengembalikan baik tag rilis repositori ini sendiri MAUPUN tag rilis `ahliweb/awcms` sendiri (`v9.x`, `v10.x` — bocor masuk lewat fetch remote itu tanpa `tagOpt: --no-tags`, "Why `--no-tags` is not optional" milik AGENTS.md). Memeriksa bahwa commit tag kandidat adalah ancestor dari `origin/main` **tidak** cukup untuk mengeluarkannya: `apps/cms` membawa riwayat PENUH `ahliweb/awcms` lewat `git subtree`, sehingga commit tag rilis upstream memang benar-benar ancestor dari `origin/main` begitu subtree sync itu mendarat — diverifikasi langsung terhadap clone repositori ini sendiri saat membangun alat ini (`git merge-base --is-ancestor v10.3.0 origin/main` menjawab true, dan `v10.3.0` adalah rilis `ahliweb/awcms` sendiri, bukan milik `awcms-one`). `release:publish` sebaliknya membaca `package.json` milik setiap tag kandidat (`git show <tag>:package.json`) dan hanya mempercayai tag yang `name`-nya cocok dengan nama `package.json` checkout ini sendiri dan `version`-nya cocok dengan tag — lihat `matchesOwnRelease` milik `tools/release/lib/tag.mjs`.

Token: `RELEASE_GITHUB_TOKEN`, jatuh kembali ke `gh auth token` (CLI `gh` yang sudah terautentikasi) jika tidak diset.

## Memverifikasi image yang dipublikasikan

Untuk image apa pun yang dipublikasikan `tools/release/images.ts` (setelah ADR-0023):

```bash
cosign verify --key <kunci-publik-cosign-yang-dipublikasikan> \
  ghcr.io/<owner>/<repo>-cms@sha256:<digest>
```

Kunci publik didistribusikan bersama rilis (bundel buktinya sendiri, atau dokumentasi operasional repositori ini sendiri — tidak pernah dikomit ke repo itu sendiri, karena dimaksudkan untuk bertahan lebih lama dari commit mana pun).

Untuk image yang dipublikasikan **sebelum** ADR-0023 (oleh `.github/workflows/images.yml`, dengan `actions/attest-build-provenance`), perintah lama masih berfungsi dan akan selalu berfungsi — atestasi itu nyata dan diterbitkan GitHub pada saat itu:

```bash
gh attestation verify oci://ghcr.io/<owner>/<repo>-cms:<tag> --owner <owner>
```

Kedua perintah tetap terdokumentasi di sini, berdampingan, ketimbang yang lama diam-diam menjadi usang.

## Berlatih tanpa menyentuh GHCR

Jalur publish lengkap milik `tools/release/images.ts` (build → push → baca-kembali digest → tandatangani → verifikasi → pindai → SBOM → bukti) bisa dilatih end-to-end terhadap registry lokal sekali pakai, tanpa mem-push apa pun yang nyata atau menyentuh kunci produksi:

```bash
# 1. Registry sekali pakai, terbind hanya ke localhost.
docker run -d --name rehearsal-registry -p 5999:5000 registry:2

# 2. Pasangan kunci cosign sekali pakai, di direktori yang tidak dibaca apa pun lain.
mkdir -m 777 /tmp/rehearsal-cosign   # 777 hanya karena container cosign
                                      # berjalan sebagai uid non-root;
                                      # hapus direktori ini setelah selesai.
docker run --rm -e COSIGN_PASSWORD=rehearsal-pw -e COSIGN_YES=true \
  -v /tmp/rehearsal-cosign:/work -w /work \
  gcr.io/projectsigstore/cosign@sha256:<digest yang dipin — lihat tools/release/lib/pinned-images.mjs> \
  generate-key-pair

# 3. Tag LOKAL-SAJA sementara, tidak pernah di-push ke origin.
git tag v99.99.99 HEAD

# 4. Jalannya percobaan itu sendiri.
RELEASE_DANGEROUSLY_SKIP_ANCESTOR_CHECK=1 \
GHCR_USER=x GHCR_TOKEN=x \
COSIGN_KEY=/tmp/rehearsal-cosign/cosign.key \
COSIGN_PASSWORD=rehearsal-pw \
COSIGN_PUBLIC_KEY=/tmp/rehearsal-cosign/cosign.pub \
RELEASE_EVIDENCE_DIR=/tmp/rehearsal-evidence \
bun run release:images -- --publish --tag v99.99.99 \
  --registry localhost:5999 --owner <owner> --repo <repo>

# 5. Bersihkan — setiap satu ini, setiap kali.
git tag -d v99.99.99
docker rm -f rehearsal-registry
rm -rf /tmp/rehearsal-cosign /tmp/rehearsal-evidence
docker logout localhost:5999
```

`RELEASE_DANGEROUSLY_SKIP_ANCESTOR_CHECK=1` ada persis untuk ini — tag percobaan tidak akan pernah bisa menjadi ancestor `origin/main` secara konstruksi — dan dicatat dengan keras oleh skrip itu sendiri setiap kali diset. Tidak ada kegunaan legitimate lain; rilis nyata selalu men-tag commit yang sudah ada di `origin/main`, sehingga pengecekan ancestry nyata selalu lolos untuknya dan variabel ini tidak pernah diperlukan di sana.

Dua mekanika Docker yang perlu diketahui sebelum menjalankan ini secara manual:

- Builder buildx `docker-container` yang dibuat alat ini (`awcms-one-release`, atau apa pun yang disebut `--builder`) dibuat dengan `--driver-opt network=host` khusus agar bisa menjangkau registry yang terbind ke `localhost` milik release host sendiri — builder `docker-container` biasanya menjalankan BuildKit di namespace jaringannya sendiri dan tidak bisa melihatnya.
- Setiap `docker run` yang dibuat alat ini untuk `cosign`/`trivy`/`syft` juga berjalan dengan `--network host`, untuk alasan yang sama.

## Mengeskalasi rilis yang terblokir

| Sinyal | Muncul di mana | Apa yang dilakukan |
| --- | --- | --- |
| `release:images` menolak mempublikasikan | Error-nya sendiri, menyebut setiap prasyarat yang tidak terpenuhi sekaligus | Perbaiki masing-masing yang disebut — tree kotor, `HEAD` bukan tag, tag tidak terjangkau dari `origin/main`, atau tidak ada `COSIGN_KEY` yang dikonfigurasi |
| trivy memblokir pada temuan CRITICAL | `<evidence-dir>/<target>-trivy.json` | Perbarui image dasar, atau catat pengecualian beralasan dan berjangka waktu di `SECURITY.md` — jangan pernah melebarkan filter severity hanya agar lolos |
| cosign verify gagal tepat setelah menandatangani | Error skrip itu sendiri, sebelum apa pun lain berjalan | Kunci dan kunci publik tidak cocok, atau registry menyajikan sesuatu selain yang baru saja di-push — berhenti dan investigasi; jangan pernah mengulang secara membabi buta |
| `--latest` terlihat salah untuk rilis yang seharusnya terbaru | Baris log skrip itu sendiri, `--latest computation: ...` | `release:publish` sudah menyaring `git tag -l 'v*'` menjadi tag rilis repositori ini sendiri lewat identitas package (lihat di atas) — jika masih terlihat salah, periksa `git show <tag-yang-diharapkan>:package.json` benar-benar memiliki `name`/`version` repositori ini sendiri pada commit itu |
