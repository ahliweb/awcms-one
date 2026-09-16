/** The home page's public-voucher strip: click `[data-voucher-copy]` to copy its `data-code` to the clipboard. Falls back silently when the Clipboard API is unavailable/denied — the code is already printed in the chip's own text, so a shopper can still select and copy it by hand. */
document.querySelectorAll<HTMLButtonElement>("[data-voucher-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const code = button.dataset.code ?? "";
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code);
      const original = button.textContent;
      button.textContent = "Tersalin!";
      setTimeout(() => {
        button.textContent = original;
      }, 2000);
    } catch {
      // Clipboard unavailable/denied — no-op, the code is already visible.
    }
  });
});
