# Centuari Matching Engine — Rencana Adaptasi (CEX → Centuari)

> **Untuk AI agent / engineer:** Dokumen ini adalah rencana perbaikan matching
> engine Centuari, diturunkan dari audit teknis dan dari pendekatan CEX global.
> Baca bagian `CONTEXT` dan `ATURAN MAIN` lebih dulu sebelum menyentuh kode apa pun.

---

## CONTEXT

Centuari adalah protokol fixed-rate lending dengan **hybrid order book**: order
di-match off-chain, di-settle on-chain (Arbitrum). Engine ditulis dalam
TypeScript di atas Node.js single-process / single-threaded.

**Masalah yang sedang ditangani:** memory leak di matching engine. Akar masalah
sudah teridentifikasi lewat audit — bukan karena banyaknya order, melainkan
karena **order tidak punya jalur terminasi yang lengkap** (tidak ada konsep
expiry berbasis maturity).

### Tiga perbedaan fundamental Centuari vs CEX (WAJIB dipahami sebelum adaptasi apa pun)

1. **Sumbu order book = rate (basis points 0–10000), bukan harga.** Domain
   diskret & finite. Berbeda dari harga aset yang praktis tak terbatas.
2. **Order terikat `maturity`, dan maturity berputar.** Maturity = tanggal 1
   tiap bulan, maksimal 3 aktif, auto-rotate. Tidak ada padanannya di CEX.
   Setiap order punya "ajal alami".
3. **Hybrid: match off-chain, settle on-chain.** Ada jeda antara keadaan
   `matched` dan `settled` yang tidak dimiliki CEX murni.

Setiap keputusan adaptasi di bawah bergantung pada ketiga hal ini.

---

## ATURAN MAIN (baca sebelum implementasi)

- **Urutkan pekerjaan berdasarkan BAHAYA, bukan kerumitan teknis.** Bug yang
  menyentuh uang didahulukan, walau perbaikannya kecil.
- **Hanya Adaptasi 1 yang menyembuhkan memory leak.** Adaptasi 2, 3, 4
  masing-masing mengurung / membatasi laju / mengoptimasi — bukan obat leak.
  Jangan kerjakan Adaptasi 2–4 "atas nama" memperbaiki leak.
- **`removeOrder()` saat ini SUDAH BENAR dan lengkap** (`order-book.ts:84-118`).
  Jangan ubah logikanya. Perbaikan = menambah *pemanggil* dan *filter* di
  sekitarnya. SATU pengecualian: jika menambah index baru (lihat Adaptasi 2),
  `removeOrder()` HARUS diperluas untuk membersihkan index itu juga.
- **Matching bersifat sinkron-sekuensial.** Jangan memutasi order book dari
  timer / thread terpisah. Semua mutasi harus lewat antrian event engine.
- Nomor baris di dokumen ini berasal dari audit dan bisa bergeser — verifikasi
  ulang terhadap kode terkini sebelum mengedit.

### Urutan eksekusi yang disarankan

```
TINGKAT 1  →  Bug correctness (uang)        [dahulukan: kecil, cepat, berisiko tinggi jika dibiarkan]
TINGKAT 2  →  Adaptasi 1 (hentikan leak)    [inti perbaikan memory leak]
TINGKAT 3  →  Observability                 [supaya keberhasilan Tingkat 2 terbukti, bukan dirasa]
TINGKAT 4  →  Adaptasi 2, 3, 4 (optimasi)   [masing-masing dengan justifikasi sendiri]
```

> Catatan: Adaptasi 1 = Tingkat 2. Adaptasi 2–4 = Tingkat 4. Tingkat 1 & 3
> bukan "adaptasi CEX" tapi wajib dikerjakan di antara keduanya.

---

## TINGKAT 1 — Bug correctness yang menyentuh uang (KERJAKAN LEBIH DULU)

Bukan masalah memory, tapi diprioritaskan karena konsekuensinya adalah dana
pengguna yang salah — bukan sekadar RAM membengkak.

### 1a. Cancel race window

- **Lokasi:** `updateOrderStatus()` — `postgres-db-client.ts:72-106`
- **Masalah:** Tidak ada guard `WHERE status = ?`. Order yang sudah `CANCELLED`
  bisa ter-overwrite kembali menjadi `FILLED`. Akibatnya: posisi on-chain yang
  seharusnya tidak ada. Sudah terdokumentasi di `CLAUDE.md` tapi belum dibereskan.
- **Perbaikan:** Tambahkan guard status pada query update.
- **Verifikasi sebelum merge:** Pastikan guard tidak memecah idempotency yang
  sudah ada (`insertMatch` memakai `ON CONFLICT (id) DO NOTHING`). Jalur status
  harus konsisten dengan itu.

### 1b. Salah-assign `remainingSettlementFeeAmount`

- **Lokasi:** `postgres-db-client.ts:432` (`getActiveOrders()`)
- **Masalah:** Field "sisa fee" diisi `row.settlement_fee` (fee TOTAL, bukan
  sisa). Setiap order partially-filled yang di-restore via DB sync salah hitung
  fee-nya.
- **Perbaikan:** Assign nilai sisa fee yang benar, bukan fee total.

---

## TINGKAT 2 — ADAPTASI 1: Order Lifecycle Tertutup (OBAT MEMORY LEAK)

**Pendekatan CEX:** setiap order dijamin punya jalan keluar — filled, cancelled,
atau expired. Tidak ada order menggantung selamanya.

**Kondisi Centuari saat ini:** enum status hanya `OPEN`, `PARTIALLY_FILLED`,
`FILLED`, `CANCELLED` (`types/orders.ts:14-19`). **Status `EXPIRED` tidak ada.**
Tidak ada timer / sweep / pengecekan `maturity` (audit bagian 3: "Expiry/TTL/
Maturity-Check: TIDAK ADA"). Inilah akar memory leak.

**Keuntungan struktur Centuari:** karena maturity berputar & sedikit (maks 3),
TIDAK perlu mesin TTL per-order ala CEX (timer heap, GTD timestamp arbitrer).
Cukup **satu event terjadwal per maturity**. Centuari dapat "expiry" hampir
gratis dari domainnya sendiri — lebih sederhana dari CEX.

### Yang harus dikerjakan

1. **Tambahkan status `EXPIRED`** ke enum `OrderStatus` (`types/orders.ts:14-19`)
   sebagai keadaan terminal.

2. **Buat maturity sweep.** Proses periodik yang mencari order dengan
   `maturity < now` lalu memanggil `removeOrder()` untuk masing-masing.
   - Sweep harus memancarkan perintah hapus **sebagai event ke antrian engine
     yang sama** dengan submit/cancel. JANGAN menyentuh order book dari timer
     terpisah (matching sinkron-sekuensial → akan race).
   - Pertimbangkan expire **sedikit SEBELUM** maturity, bukan tepat di maturity.
     Alasan: order yang match di detik akhir menghasilkan posisi berdurasi
     nyaris nol; settlement on-chain mungkin tak sempat terkonfirmasi.

3. **Maturity = plafon absolut.** Tidak ada order yang boleh hidup melewati
   maturity-nya, apa pun tipe order-nya.

4. **Filter maturity di SEMUA jalur restore/sync.** Tanpa ini, sweep runtime
   membersihkan memory tapi restart berikutnya menyuntik ulang semua zombie.
   Titik yang harus difilter (`maturity > now`):
   - `restoreFromOrders()` — `order-book.ts:308`
   - `syncFromDatabase()` — `matching-engine.ts:553`
   - `getActiveOrders()` (query DB) — `postgres-db-client.ts:410-411`
   - **Restore dari snapshot** — audit bagian 7 poin 4 menyebut snapshot tidak
     punya timestamp validitas. **TODO agent: konfirmasi titik keempat ini dan
     tambahkan filter maturity.**

5. **Jadikan `syncFromDatabase()` rekonsiliatif, bukan additive-only.** Saat ini
   additive-only (komentar eksplisit di `matching-engine.ts:536-540`): hanya
   menambah, tidak pernah menghapus divergensi. Harus mampu menghapus order yang
   ada di memory tapi sudah tidak ada di DB.

6. **Perbaiki disk spill.** `onDiskSpillNeeded()` (`retry-service.ts:116-120`)
   menyalin matches ke disk tapi **tidak menghapus dari memory**, dan dipicu
   berulang. Ini leak kedua, terpisah, di `ExecutionEngine`. Setelah berhasil
   menyalin ke disk, entri HARUS dilepas dari memory.

### Catatan

- Penumpukan map `(loanToken × maturity)` (audit bagian 6 poin 2) adalah
  **gejala dari leak yang sama**, bukan isu terpisah. Entri maturity hanya
  terhapus saat tree-nya kosong; tree maturity-lewat tidak akan pernah kosong
  tanpa sweep. Setelah langkah 2 jalan, ini ikut sembuh — **tapi VERIFIKASI,
  jangan diasumsikan.**
- Sifat hybrid Centuari menambah satu keadaan transisi: antara `matched`
  (off-chain) dan `settled` (on-chain) ada jeda. Pertimbangkan keadaan
  `MATCHED_PENDING_SETTLEMENT` — order keluar dari book yang bisa di-match,
  tapi belum dibuang dari memory sampai settlement terkonfirmasi (atau gagal
  lalu di-requeue). Jika jendela ini tidak dimodelkan: risiko double-match atau
  order matched yang menggantung (bentuk leak lain).

---

## TINGKAT 3 — Observability (supaya perbaikan TERBUKTI, bukan dirasa)

Tanpa ini, tidak ada cara membuktikan Tingkat 2 berhasil.

### Metrik berkelanjutan yang harus diekspor

- Jumlah order hidup — total dan per market.
- Umur order tertua.
- Selisih `order dibuat − order diterminasi`. **Harus berosilasi di sekitar
  nol, bukan menanjak monoton.**

### Invariant check berkala

- `count(orderIndex)` harus sama dengan jumlah total order di seluruh RBT tree.
  Audit bilang `removeOrder()` tidak bocor hari ini — invariant ini yang akan
  mendeteksi kalau perubahan di masa depan diam-diam memecahkannya.

### Idle test (bukti kausal)

- Suntik order dengan maturity yang sudah lewat → hentikan semua trafik →
  amati heap.
- **Sebelum Adaptasi 1:** heap rata-tinggi saat idle → membuktikan leak struktural.
- **Sesudah Adaptasi 1:** heap turun saat idle → membuktikan obatnya bekerja.

---

## TINGKAT 4 — ADAPTASI 2, 3, 4 (Optimasi)

Semua sah, tapi **tidak satu pun obat leak**. Kerjakan masing-masing atas nama
tujuannya sendiri, setelah Tingkat 1–3 selesai.

### ADAPTASI 2 — Hard cap per wallet per market

**Pendekatan CEX:** Binance membatasi ~200 open order per simbol per akun,
ditegakkan di lapisan API sebelum order masuk engine. Jumlah order menjadi
**berbatas secara desain**.

**Adaptasi Centuari:**
- Padanan "simbol" = `(loanToken × maturity)`. Cap per `(wallet × loanToken ×
  maturity)`.
- **Kendala (audit temuan 9):** Centuari TIDAK punya index per-wallet.
  Menghitung jumlah order open milик sebuah wallet sekarang butuh scan seluruh
  `orderIndex`. Cap ini datang sepaket dengan membangun
  `Map<walletAddress, Set<orderId>>`.
- **Bonus:** index per-wallet juga mengubah self-match prevention dari scan
  linear (`matching-engine.ts:180`) menjadi lookup.
- **PERINGATAN KERAS:** index baru = tempat referensi order baru. `removeOrder()`
  WAJIB diperluas untuk membersihkannya. Jika lupa → tercipta "leak index" yang
  saat ini Centuari justru TIDAK punya. Kemunduran ironis — jaga ketat.
- **Sifat:** mitigasi laju (membatasi seberapa cepat memory tumbuh), BUKAN obat
  leak (tidak membebaskan satu byte pun).

### ADAPTASI 3 — Isolasi per market

**Pendekatan CEX:** setiap trading pair = matching engine terisolasi secara
logis. Crash terkurung, leak terlokalisasi, skala independen.

**Kondisi Centuari:** satu engine monolitik, satu `orderIndex` & satu kumpulan
RBT bersama untuk semua market.

**Adaptasi Centuari (bertahap):**
- Batas shard alami sudah ada: `(loanToken × maturity)`. Order book secara
  konseptual sudah dipisah per pasangan itu — yang belum ada hanya isolasi runtime.
- **Tahap 1:** pisahkan engine monolitik jadi banyak instance per
  `(loanToken × maturity)`, masing-masing dengan `orderIndex` & RBT sendiri,
  di belakang satu router — **masih dalam satu proses.** Hasil: leak
  terlokalisasi (terlihat market mana yang menggelembung), penalaran lebih bersih.
- **Tahap 2:** tiap engine market jadi worker/proses sendiri (`worker_threads`
  Node sudah cukup). Crash terkurung di level OS.
- **Tahap 3:** isolasi mesin — hanya jika & ketika beban nyata menuntut.
- **Bonus unik Centuari:** karena maturity berputar, saat maturity lewat cukup
  buang seluruh instance untuk maturity itu → seluruh memory-nya lepas
  sekaligus. Sharding & pembersihan maturity jadi mekanisme yang sama.
- **Sifat:** mengurung & menampakkan leak — BUKAN menyembuhkan. Tiap shard
  tetap bocor jika Adaptasi 1 belum ada. Urutan: Adaptasi 1 dulu.

### ADAPTASI 4 — Order book di memory, persistensi terpisah

**Pendekatan CEX:** book di RAM; tiap event ditulis ke log append-only; crash →
replay log; database hanya untuk settlement & riwayat, tidak pernah di jalur
matching.

**Kondisi Centuari:** **SUDAH pada pola ini.** DB writer adalah proses terpisah,
`core/` tidak mengimpor `pg`, snapshot sudah ada. Arsitektur sudah benar.

**Yang perlu dirapikan (sebagian tumpang-tindih dengan Adaptasi 1):**
- `syncFromDatabase` additive-only → rekonsiliatif (lihat Tingkat 2 langkah 5).
- Semua jalur restore memfilter maturity (lihat Tingkat 2 langkah 4).
- Ini bukan adaptasi baru — hanya menambal pola yang sudah ada agar konsisten.

---

## YANG SEBAIKNYA TIDAK DIADAPTASI DARI SISTEM CEX(atau ditunda)

### Price-level array menggantikan RBT — TUNDA

- Godaan terbesar ("begini cara CEX"). Rate Centuari memang diskret (10.001
  level) sehingga array secara teknis cocok.
- **Tapi:** Centuari punya BANYAK book (per token × maturity). Array
  10.001-slot dialokasikan penuh **per book**; untuk market sparse, justru
  lebih boros dari RBT. CEX pakai array karena tiap pair-nya padat — Centuari
  belum tentu.
- Keputusan empiris — butuh data distribusi order nyata. Murni performa, bukan
  obat leak. Pendekatan array biasanya pakai lazy removal → jika compaction
  alpa, jadi sumber leak baru.
- **Tunda sampai Tingkat 1–3 selesai dan ada angka baseline.**

### LMAX Disruptor / lock-free ring buffer + dedicated CPU core — JANGAN

- Rekayasa untuk throughput ekstrem CEX tier-1. Centuari belum punya beban yang
  menuntutnya. Kerumitan dibeli tanpa kebutuhan.
- Jika nanti butuh isolasi thread, `worker_threads` Node sudah cukup.

### Implicit GTC expiry 90 hari ala Binance — TIDAK RELEVAN

- Binance perlu ini karena order GTC mereka betul-betul abadi. Order Centuari
  sudah punya ajal alami via maturity (maks ~3 bulan). Maturity sudah jadi
  expiry universal — tidak perlu aturan 90 hari di atasnya.
---

## RINGKASAN UNTUK AGENT

| Item | Tingkat | Menyembuhkan leak? | Aksi |
|---|---|---|---|
| 1a. Cancel race window guard | 1 | Tidak (bug uang) | Kerjakan duluan |
| 1b. Fix `remainingSettlementFeeAmount` | 1 | Tidak (bug uang) | Kerjakan duluan |
| Adaptasi 1: lifecycle tertutup + sweep | 2 | **YA** | Inti perbaikan |
| Observability + idle test | 3 | Tidak (bukti) | Wajib, setelah T2 |
| Adaptasi 2: cap per wallet | 4 | Tidak (mitigasi laju) | Optimasi |
| Adaptasi 3: isolasi per market | 4 | Tidak (mengurung) | Optimasi bertahap |
| Adaptasi 4: rapikan recovery | 4 | Sebagian (overlap T2) | Tambal pola lama |
| Price-level array | — | Tidak | Tunda — butuh data |
| LMAX / dedicated core | — | Tidak | Jangan |

**Satu kalimat inti:** memory leak Centuari disembuhkan oleh Adaptasi 1
(lifecycle order tertutup + maturity sweep + filter di semua jalur restore);
segalanya yang lain mengurung, membatasi laju, mengoptimasi, atau memperbaiki
bug terpisah — penting, tapi bukan obat leak.