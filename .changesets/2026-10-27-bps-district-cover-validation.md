---
bump: patch
type: fix
impact: internal
---

# Reject BPS district PDFs whose cover names another district

Some BPS publication pages for Nusa Tenggara Timur yielded PDFs for a different kecamatan. The extractor previously trusted the page title and could produce internally consistent figures under the wrong region code. It now compares a readable PDF cover title with the selected district and refuses a mismatch before writing a dataset. The misattributed NTT dataset pairs were removed from the pending batch.
