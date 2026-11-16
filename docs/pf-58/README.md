# PF-58 evidence (Contact Option B)

- `frame06-print-before-after.png`: lit Frame 06 print, main 5b1b0a6 vs this branch (crop of the d-5 still, a 1440×900 render of the live scene at p = .96).
- `frame06-paper-crop-{before,after}.png` + `frame06-speckle-metric.json`: text-free paper crop, 8-bit luma minus a 31 px box blur, std dev 12.84 → 0.47 (bar ≤ 4).
- `pinned-1440x900-default.png`, `pinned-1280x800-error.png`: full tier pinned at p = .96.
- `mobile-390x844-{default,error}.png`: static tier phone.

Full set (1440/1280 default, error, success; a11y report; JS budget before/after): factory `evidence/CONTACT-redesign/PF-58-after/`.
