---
title: Nusantara LST — Sistem Pemantauan Suhu Permukaan Bumi Indonesia
emoji: 🛰️
colorFrom: yellow
colorTo: red
sdk: static
pinned: false
license: mit
---

# Nusantara Thermal & Surface Intelligence (Fase 1–6)

Sistem pemantauan & deteksi Suhu Permukaan Daratan (*Land Surface Temperature* / LST) multi-satelit 100% gratis untuk **Seluruh Indonesia** (`[94.5°BT – 141.5°BT, 11.5°LS – 6.5°LU]`) dengan prioritas **Pulau Kalimantan**.

- **Tier-1 Near-Realtime (10 Menit)**: Himawari-9 AHI Band 13 (10.4 µm) & Band 14 (11.2 µm) *Split-Window Algorithm* + koreksi sudut pandang (*Viewing Zenith Angle*).
- **Tier-2 Harian & Jam (Fusi Multi-Satelit)**: Gabungan Himawari-9 AHI + Suomi-NPP / NOAA-20 VIIRS + Sentinel-3 SLSTR dengan *Terrain-Aware Lapse-Rate Downscaling* (`-6.5 °C/km`).
- **Tier-3 Resolusi Tinggi (30m–100m)**: Landsat 8/9 Collection-2 Level-2 Surface Temperature (`ST_B10`) untuk **13 kawasan perkotaan & strategis** di Kalimantan dan seluruh Indonesia.
- **Tier-4 Anomali Termal & Validasi**: Anomali suhu permukaan (`ΔLST`), *Z-score* (`> μ + 2σ`), serta evaluasi *bias* & RMSE terhadap **18 stasiun sinoptik BMKG**.
