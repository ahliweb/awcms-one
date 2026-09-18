/**
 * The click-to-load YouTube facade (issue #47) — swaps
 * `src/lib/portable-text.ts`'s `renderVideoNewsNode` poster/button markup
 * for a real `<iframe>` on activation, and only on activation. Loaded ONLY
 * from `src/pages/video/[slug].astro` — the only route a playable
 * `videoNews` block can ever render on (`src/lib/berita.ts`'s own
 * `getPosts()`/`getVideo()` routing rule keeps a video post off
 * `/berita/{slug}` entirely), so this module never runs on a page that
 * cannot possibly contain the markup it looks for.
 *
 * `script-src 'self'` (`server/penyaji.mjs`) has no `'unsafe-inline'` — this
 * file is an ordinary Astro-bundled external module, imported from a
 * `<script>` block the same way `src/components/Header.astro` already
 * imports `keranjang-hitung.ts`/`wishlist-tombol.ts`.
 *
 * ## Why a real `<button>`, not a `<div onclick>`
 *
 * `src/lib/portable-text.ts` already renders a real, focusable
 * `<button type="button">` — Enter/Space activates it with no keyboard
 * handling of any kind needed here. This script only needs a `click`
 * listener.
 */

function activate(figure: HTMLElement): void {
  const videoId = figure.dataset.videoId;
  if (!videoId) return;

  const title = figure.dataset.videoTitle ?? "Video berita";
  const button = figure.querySelector<HTMLButtonElement>("[data-video-facade-button]");
  if (!button) return;

  const iframe = document.createElement("iframe");
  iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;
  iframe.title = title;
  iframe.loading = "lazy";
  iframe.allow =
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
  iframe.allowFullscreen = true;
  iframe.width = "560";
  iframe.height = "315";
  iframe.className = "content-video-frame";

  button.replaceWith(iframe);
}

function init(): void {
  const figures = document.querySelectorAll<HTMLElement>("[data-video-facade]");

  for (const figure of figures) {
    const button = figure.querySelector<HTMLButtonElement>("[data-video-facade-button]");
    button?.addEventListener(
      "click",
      () => activate(figure),
      // Once: a second click, after the iframe has replaced the button,
      // has nothing left to listen on anyway — this just avoids relying on
      // that as the only reason the handler stops running.
      { once: true }
    );
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
