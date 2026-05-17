# AUDIT TEKNIS MATCHING ENGINE CENTUARI

> Dihasilkan oleh: Claude Code (claude-sonnet-4-6)
> Tanggal audit: 2026-05-17
> Branch: staging
> Commit terakhir: 4bc3986

**Metodologi**: Setiap klaim dalam dokumen ini berbasis pembacaan langsung kode sumber dengan referensi file:baris. Klaim yang bersifat dugaan ditandai `[INFERENSI]`. Jika sesuatu tidak ditemukan di kode, ditulis eksplisit "TIDAK ADA/TIDAK DITEMUKAN".

---

## 1. PETA STRUKTUR

### Bahasa & Runtime

- **Bahasa**: TypeScript (strict mode) berjalan di Node.js
- **Runtime**: Single-process, single-threaded (Node.js event loop)
- **Package manager**: pnpm (scripts via npm)

### Dependency Utama

| Dependency | Fungsi |
|---|---|
| `functional-red-black-tree` | Struktur data order book |
| `nats` | Message bus (order ingestion, status publishing) |
| `ioredis` | Redis Streams (settlement match publishing) |
| `pg` (node-postgres) | Database PostgreSQL |
| `zod` | Validasi schema di semua boundary |
| `pino` | Structured logging |
| `uuid` | ID generation |

### File Inti + Tanggung Jawab

| File | Tanggung Jawab |
|---|---|
| `core/matching-engine.ts` | Orchestrator utama: menerima order, memanggil matching, mengelola snapshot |
| `core/order-book.ts` | Menyimpan order aktif via Red-Black Tree, operasi add/remove/update |
| `core/execution-engine.ts` | Menyimpan buffer match, publish ke Redis, retry logic interface |
| `services/main.ts` | Entry point: init semua komponen, urutan startup, signal handlers |
| `services/message-handlers.ts` | Parsing NATS messages, routing ke engine, publish status ke NATS |
| `services/nats-service.ts` | Koneksi NATS, setup subscriptions |
| `services/redis-service.ts` | Koneksi Redis, publish ke Stream `settlement:matches` |
| `services/snapshot-service.ts` | Simpan/load state engine ke filesystem + Redis backup |
| `services/retry-service.ts` | Exponential backoff retry untuk publish yang gagal |
| `services/disk-persistence-service.ts` | Flush/load unpublished matches ke disk |
| `services/db-writer-main.ts` | Entry point proses DB writer (terpisah dari engine) |
| `services/db-writer-service.ts` | Konsumsi NATS + Redis Stream, tulis ke PostgreSQL |
| `services/db/postgres-db-client.ts` | Raw pg queries: insert match, update order status, lock balance |
| `types/orders.ts` | Zod schema + TypeScript types untuk semua varian order |
| `types/matches.ts` | Zod schema + TypeScript types untuk Match, MatchResult |
| `types/messages.ts` | Zod schema untuk NATS messages, error codes, helper builders |
| `types/snapshot.ts` | Zod schema untuk snapshot data |
| `utils/helpers.ts` | Big number math, fee calculation, order comparator, ID generation |
| `config/buffer-config.ts` | Konfigurasi buffer dari env vars (retry, thresholds, disk spill) |
| `config/nats-config.ts` | Konfigurasi NATS + konstanta topic |
| `config/redis-config.ts` | Konfigurasi Redis + konstanta stream/consumer group |

---

## 2. STRUKTUR DATA ORDER BOOK

### Representasi

Order book diimplementasikan dengan tiga struktur di `OrderBook` (`core/order-book.ts:17-35`):

```typescript
// core/order-book.ts:19-23
private lendOrders: Map<string, Map<number, RBTree>>;    // Map<loanToken, Map<maturity, RBTree>>
private borrowOrders: Map<string, Map<number, RBTree>>;  // Map<loanToken, Map<maturity, RBTree>>
private orderIndex: Map<string, OrderMetadata & { order: Order }>;
```

`RBTree` adalah alias untuk `createRBTree.Tree<Order, null>` dari library `functional-red-black-tree` (immutable persistent red-black tree). `core/order-book.ts:12`.

### Unit Pemisahan Book

Per **(loanToken × maturity)**. Setiap pasangan token-maturity mendapat RBT sendiri. `core/order-book.ts:58-74`.

### Index Per Order

Saat `addOrder()` dipanggil (`core/order-book.ts:42-76`), satu order masuk ke:

1. **`orderIndex`** — 1 entry, key = `orderId` (`core/order-book.ts:44-52`)
2. **RBT per market slot** — N insertions, satu per elemen `order.markets[]` (`core/order-book.ts:58-75`)

**Kesimpulan**: Satu order dengan N market slots direferensikan di `1 + N` lokasi sekaligus. Tidak ada index per-wallet.

Saat `removeOrder()` (`core/order-book.ts:84-118`), order dihapus dari seluruh N RBT trees dan dari `orderIndex`. Penghapusan bersifat lengkap.

### Anatomi Objek Order

Semua field dari union `types/orders.ts`:

| Field | Tipe | Keterangan |
|---|---|---|
| `orderId` | `string` (UUID) | `orders.ts:71` |
| `walletAddress` | `string` (Ethereum addr) | `orders.ts:72` |
| `loanToken` | `string` (Ethereum addr) | `orders.ts:73` |
| `assetId` | `string` (UUID) | `orders.ts:74` |
| `markets` | `MarketSlot[]` (min 1) | `orders.ts:75-77` — array `{ marketId: bytes32Hex, maturity: number }` |
| `timestamp` | `number` (ms epoch) | `orders.ts:78` |
| `side` | `OrderSide` (LEND\|BORROW) | `orders.ts:79` |
| `type` | `OrderType` (MARKET\|LIMIT) | `orders.ts:80` |
| `status` | `OrderStatus` (default OPEN) | `orders.ts:81` |
| `originalAmount` | `string` (digit-only) | `orders.ts:88` — tidak pernah berubah |
| `remainingAmount` | `string` (digit-only) | `orders.ts:96` — dikurangi per match |
| `settlementFeeAmount` | `string` (digit-only) | `orders.ts:104` — tidak pernah berubah |
| `remainingSettlementFeeAmount` | `string?` (digit-only) | `orders.ts:112-115` — opsional, internal |
| `rate` | `number` (0-10000 bps) | Hanya ada di LIMIT orders (`orders.ts:134-138`, `orders.ts:173-176`) |
| `collateralAssets` | `string[]` (Ethereum addr) | Hanya ada di BORROW orders, default `[]` (`orders.ts:151-152`) |

---

## 3. LIFECYCLE ORDER

### Status yang Mungkin

```typescript
// types/orders.ts:14-19
enum OrderStatus {
  Open = 'OPEN',
  PartiallyFilled = 'PARTIALLY_FILLED',
  Filled = 'FILLED',
  Cancelled = 'CANCELLED',
}
```

### Transisi Status: Fungsi & Lokasi

**OPEN → PARTIALLY_FILLED (maker)**
- Dipicu oleh: `matchAgainstBook()` di `core/matching-engine.ts:258-269`
- Kondisi: `!isZero(makerRemainingAmount)` setelah dikurangi matchAmount
- Mekanisme: `OrderBook.updateOrderAmount()` di `core/order-book.ts:128-155`, baris 145 set status: `isZero(newRemainingAmount) ? Filled : PartiallyFilled`
- Order di-remove lalu di-add ulang dengan `remainingAmount` baru

**OPEN → PARTIALLY_FILLED (taker limit)**
- Dipicu oleh: akhir `matchAgainstBook()` di `core/matching-engine.ts:285-292`
- Kondisi: `takerIsLimit && !isZero(remainingAmount) && matches.length > 0`
- Mekanisme: `OrderBook.addOrder()` dengan `status: PartiallyFilled` (`core/matching-engine.ts:290`)

**OPEN/PARTIALLY_FILLED → FILLED (maker)**
- Dipicu oleh: `matchAgainstBook()` di `core/matching-engine.ts:262-263`
- Kondisi: `isZero(makerRemainingAmount)`
- Mekanisme: `OrderBook.removeOrder(makerOrder.orderId)` — order hilang dari memory

**OPEN/PARTIALLY_FILLED → FILLED (taker)**
- Dipicu oleh: `matchAgainstBook()` — taker tidak pernah ditambahkan ke book jika `remainingAmount == 0`
- Tidak ada perubahan state di memory (market order tidak pernah masuk book; limit order sudah punya remainingAmount = 0)

**OPEN/PARTIALLY_FILLED → CANCELLED (cancel eksplisit)**
- Dipicu oleh: `MatchingEngine.cancelOrder()` di `core/matching-engine.ts:304-327`
- Mekanisme: `OrderBook.removeOrder(orderId)` di `core/matching-engine.ts:321`
- Guard: hanya allow jika status `OPEN` atau `PARTIALLY_FILLED` (`core/matching-engine.ts:316`)
- Status CANCELLED hanya dipublish ke NATS, tidak disimpan di memory (order sudah tidak ada)

**OPEN/PARTIALLY_FILLED → (removed via updateOrder)**
- Dipicu oleh: `MatchingEngine.updateOrder()` di `core/matching-engine.ts:329-352`
- Mekanisme: `OrderBook.removeOrder(orderId)` di `core/matching-engine.ts:346`, lalu order direkonstruksi dan di-submit ulang via `handleUpdateOrder()` di `services/message-handlers.ts:466`

### Jalur Keluar dari Memory

Order keluar dari memory (`orderIndex` + semua RBT trees) melalui `OrderBook.removeOrder()` (`core/order-book.ts:84-118`), yang dipanggil dari:

1. `matchAgainstBook()` — maker fully filled (`core/matching-engine.ts:263`)
2. `OrderBook.updateOrderAmount()` — internal, remove sebelum re-add (`core/order-book.ts:139`)
3. `MatchingEngine.cancelOrder()` (`core/matching-engine.ts:321`)
4. `MatchingEngine.updateOrder()` (`core/matching-engine.ts:346`)
5. `OrderBook.clear()` (`core/order-book.ts:267-271`)
6. `OrderBook.restoreFromOrders()` via `clear()` (`core/order-book.ts:303`)

Market orders (taker): **tidak pernah masuk ke book** sehingga tidak perlu diremove. Guard di `core/matching-engine.ts:285`:

```typescript
// core/matching-engine.ts:285-292
if (takerIsLimit && !isZero(remainingAmount)) {
  this.orderBook.addOrder({ ... });
}
```

### Expiry/TTL/Maturity-Check

**TIDAK ADA.** Tidak ada timer, background job, atau logika yang memeriksa apakah `market.maturity` sudah terlewati. Order dengan maturity yang sudah expired tetap di memory sampai di-match, di-cancel secara eksplisit, atau sampai engine restart.

### Penghapusan dari Semua Index saat Terminal

**Ya, penghapusan bersifat lengkap** via `removeOrder()` di `core/order-book.ts:84-118`:
- Loop melalui semua `market` di `metadata.markets` dan remove dari setiap RBT (`core/order-book.ts:93-113`)
- Hapus dari `orderIndex` (`core/order-book.ts:116`)
- Tidak ada kebocoran index yang ditemukan.

---

## 4. MATCHING & CONCURRENCY

### Order Type yang Didukung

| Type | Maker? | Taker? | Sisa Order |
|---|---|---|---|
| `LEND LIMIT` | Ya (masuk ke book) | Ya | Sisa tetap di book (GTC) |
| `LEND MARKET` | Tidak | Ya | Sisa di-cancel (IOC) |
| `BORROW LIMIT` | Ya (masuk ke book) | Ya | Sisa tetap di book (GTC) |
| `BORROW MARKET` | Tidak | Ya | Sisa di-cancel (IOC) |

**Penting**: Market order vs market order tidak bisa match. Guard di `core/matching-engine.ts:185`:

```typescript
// core/matching-engine.ts:185
if (!isLimitOrder(makerOrder)) continue;
```

Hanya limit orders yang bisa menjadi maker.

### Algoritma Matching

**Price-time priority** via komparator RBT (`utils/helpers.ts:91-119`):
- **Lend book**: rate ascending, lalu timestamp ascending (terlama = prioritas lebih tinggi)
- **Borrow book**: rate descending, lalu timestamp ascending

**Rate filtering untuk limit taker** (`core/matching-engine.ts:190-199`):
- Lend taker: `if (makerRate < takerRate) continue` — skip borrow maker yang ratenya terlalu rendah
- Borrow taker: `if (makerRate > takerRate) break` — stop karena lend book sorted ascending, semua berikutnya lebih mahal

**Partial fill** (`core/matching-engine.ts:203`):

```typescript
const matchAmount = minBigNumber(remainingAmount, makerOrder.remainingAmount);
```

Loop berlanjut ke maker berikutnya sampai taker habis atau book habis.

**Execution rate**: selalu rate milik maker (limit order) (`core/matching-engine.ts:187`).

### Model Threading

Node.js **single-threaded**. Tidak ada worker threads. Semua operasi berjalan di satu event loop:

| Operasi | Blocking? |
|---|---|
| NATS message callback | Sinkron (blocking) |
| `submitOrder()` / `cancelOrder()` | Sinkron (blocking) |
| Redis publish | Async, non-blocking (Promise) |
| Snapshot save | Async, non-blocking (`saveSnapshotAsync()`) |
| Retry timers | `setTimeout` di `services/retry-service.ts:73` |

Implikasinya: selama satu `submitOrder()` berjalan (mengiterasi order book), NATS messages berikutnya mengantri di event loop.

### Pemisahan Matching dari I/O

**Ya, secara arsitektur terpisah.** `core/` tidak mengimpor NATS/Redis/pg. Semua I/O ada di `services/`. Namun secara runtime semuanya berjalan dalam satu event loop Node.js yang sama.

### Catatan: Fee Config per Iterasi Match

`calculateMakerFee()` dan `calculateTakerFee()` di `utils/helpers.ts:200-217` memanggil `loadFeeConfig()` setiap kali dipanggil. `loadFeeConfig()` membaca dari `process.env` setiap invokasi tanpa caching. **[INFERENSI]**: ini bisa menjadi overhead di volume tinggi karena tidak ada caching fee config di level matching loop.

---

## 5. PERSISTENSI & RECOVERY

### Bagaimana Order Disimpan ke DB

**Matching engine tidak menulis langsung ke DB.** DB writer adalah proses terpisah (`services/db-writer-main.ts`) yang mengonsumsi:

| Source | Topic/Stream | Handler | Fungsi |
|---|---|---|---|
| NATS | `orders.status` | `updateOrderStatus()` | Update status + filled quantity |
| NATS | `orders.cancelled_remainder` | `insertCancelledOrder()` | Insert IOC remainder cancellation |
| NATS | `orders.updated` | `updateOrderParameters()` | Update rate/amount setelah edit |
| Redis Stream | `settlement:matches` | `insertMatch()` | Insert match + lock `user_balance.in_orders` |

`insertMatch()` menggunakan `ON CONFLICT (id) DO NOTHING` untuk idempotency (`services/db/postgres-db-client.ts:210`).

`updateOrderStatus()` **tidak** memiliki guard `WHERE status = ?` — ini adalah cancel race window yang terdokumentasi di `CLAUDE.md` (`services/db/postgres-db-client.ts:72-106`).

### Saat Restart: Bagaimana Book Di-Rebuild

Urutan startup di `services/main.ts:120-298`:

1. Redis connect (opsional — jika gagal, dilanjutkan tanpa Redis)
2. Init `SnapshotService`
3. Init buffer management (retry + disk persistence)
4. Init `MatchingEngine`
5. **`restoreFromSnapshot()`** — load dari filesystem → fallback Redis (`core/matching-engine.ts:501-530`)
6. **Load disk-spilled matches** jika ada file dari crash sebelumnya (`services/main.ts:209-228`)
7. **`syncFromDatabase()`** — additive sync dari DB (`services/main.ts:231-244`)
8. Init NATS (mulai terima orders)
9. Start periodic snapshot timer (default 30 detik, env `SNAPSHOT_INTERVAL_SECONDS`)

### Apakah Rebuild Memfilter Order Tidak Valid?

- `restoreFromOrders()`: hanya restore jika `!isZero(order.remainingAmount)` (`core/order-book.ts:308`)
- `syncFromDatabase()`: hanya add jika `!isZero(order.remainingAmount)` (`core/matching-engine.ts:553`)
- `getActiveOrders()` di DB: `WHERE o.status IN ('OPEN', 'PARTIALLY_FILLED') AND o.type = 'LIMIT'` (`services/db/postgres-db-client.ts:410-411`)

**TIDAK ADA maturity-check** saat restore. Order yang sudah melewati maturity tetap di-restore ke memory selama `remainingAmount > 0` dan statusnya masih `OPEN`/`PARTIALLY_FILLED`.

### Bug Potensial: `remainingSettlementFeeAmount` Salah Setelah DB Sync

`getActiveOrders()` di `services/db/postgres-db-client.ts:432` meng-assign:

```typescript
remainingSettlementFeeAmount: row.settlement_fee,  // postgres-db-client.ts:432
```

Field ini di-set dengan `settlement_fee` (fee total), **bukan** sisa fee yang sebenarnya. Query tidak menghitung sisa fee dari `filled_settlement_fee`. Untuk partially-filled orders yang di-restore via DB sync, nilai `remainingSettlementFeeAmount` akan lebih besar dari yang sebenarnya.

### Sinkronisasi Memory↔DB: Additive atau Rekonsiliatif?

**Additive only.** Komentar eksplisit di `core/matching-engine.ts:536-540`:

> "Adds any orders that exist in the database but are missing from the in-memory order book. This is additive only — it does not remove orders that are in memory but not in the database."

Tidak ada mekanisme untuk mendeteksi dan menghapus order yang ada di memory tapi sudah tidak ada atau sudah terminal di DB.

---

## 6. PERTUMBUHAN MEMORY

### Struktur yang Bisa Tumbuh Tanpa Upper Bound

1. **`OrderBook.orderIndex`** (`core/order-book.ts:23`): `Map<orderId, ...>` — satu entry per order aktif. **Tidak ada cap.** Tumbuh seiring jumlah limit orders yang open.

2. **`OrderBook.lendOrders` / `borrowOrders`** (`core/order-book.ts:19-20`): Nested maps tumbuh per (token × maturity). Tree kosong dihapus saat semua order di market itu habis (`core/order-book.ts:102-106`). Namun `loanToken` key di Map luar **tidak pernah dihapus** — `tokenMap` kosong tetap ada. **[INFERENSI]**: kebocoran kecil, tidak signifikan.

3. **`ExecutionEngine.matchesByLendOrder` / `matchesByBorrowOrder`** (`core/execution-engine.ts:22-23`): Tumbuh bersama buffer matches. Set kosong dihapus saat `removeMatch()` (`core/execution-engine.ts:232-235`, `241-244`).

### Hard Cap

- **`ExecutionEngine.matches`**: `maxBufferSize` default **10000** (env `BUFFER_MAX_SIZE`, `config/buffer-config.ts:60`). Saat cap tercapai, `recordMatch()` melempar `Error` (`core/execution-engine.ts:102-106`):

```typescript
// core/execution-engine.ts:102-106
if (this.maxBufferSize > 0 && this.matches.size >= this.maxBufferSize) {
  throw new Error(
    `Buffer full: ${this.matches.size} matches (max ${this.maxBufferSize}). Rejecting new match.`
  );
}
```

- **`OrderBook`**: **TIDAK ADA hard cap.**

### Eviction/Cleanup Terjadwal

**TIDAK ADA** scheduled eviction atau sweep untuk order book.

Untuk execution engine:
- Match dihapus setelah berhasil dipublish ke Redis (`core/execution-engine.ts:193`)
- Disk spill (`onDiskSpillNeeded`) dipicu setiap kali buffer melewati threshold (`core/execution-engine.ts:373-375`) — bukan hanya sekali. Disk spill **menyalin** matches ke disk tapi **tidak menghapus dari memory**. Bukan mekanisme eviction.

### Untuk Order Multi-Market

Satu order dengan N market slots menghasilkan:
- **1** insertion ke `orderIndex`
- **N** insertions ke RBT trees (satu per `market.maturity`)

Total referensi di memory = `1 + N`.

---

## 7. RINGKASAN

### 10 Temuan Paling Penting (Faktual)

**1. Tidak ada expiry/maturity enforcement**
Engine tidak memiliki mekanisme apapun untuk membersihkan order yang sudah melewati `maturity` timestamp. Tidak ada timer, tidak ada sweep. Tidak ada satu baris kode pun yang membandingkan waktu saat ini dengan `market.maturity` untuk menentukan apakah order masih valid.
*(Relevan: seluruh `core/`, `services/main.ts`)*

**2. Disk spill bukan eviction**
`onDiskSpillNeeded()` di `services/retry-service.ts:116-120` hanya menyalin matches ke disk, tidak menghapus dari memory. Dipanggil berulang setiap siklus `checkThresholds()` (`core/execution-engine.ts:373-375`). Memory terus tumbuh hingga `maxBufferSize` tercapai.

**3. Cancel race window tanpa guard**
`updateOrderStatus()` di `services/db/postgres-db-client.ts:72-106` tidak memiliki `WHERE status = ?` guard. Cancel yang datang setelah engine publish match tapi sebelum DB writer flush status `FILLED` bisa di-overwrite. Terdokumentasi di `CLAUDE.md`.

**4. Sync dari DB bersifat additive only**
`syncFromDatabase()` di `core/matching-engine.ts:544-560` hanya menambah order, tidak pernah menghapus divergensi. Tidak ada cara untuk mendeteksi order yang masih di memory tapi sudah terminal di DB.

**5. `remainingSettlementFeeAmount` salah setelah DB sync**
`getActiveOrders()` di `services/db/postgres-db-client.ts:432` meng-assign full `settlement_fee` sebagai `remainingSettlementFeeAmount`, bukan sisa fee yang dihitung dari `filled_settlement_fee`. Partially-filled orders yang di-restore via DB sync akan punya fee pool yang lebih besar dari sebenarnya.

**6. Market order vs market order tidak bisa match**
Guard di `core/matching-engine.ts:185`: `if (!isLimitOrder(makerOrder)) continue`. Lend market dan borrow market tidak akan pernah berpasangan karena market orders tidak masuk ke book (sehingga tidak ada yang bisa menjadi maker).

**7. Order dengan N market slots masuk ke N+1 struktur**
`addOrder()` di `core/order-book.ts:42-76` menyisipkan ke `orderIndex` (1x) dan ke N RBT trees. Satu order bisa punya multiple market slots, dan setiap slot merupakan insertion terpisah ke tree berbeda.

**8. Matching bersifat synchronous dan blocking**
`submitOrder()` di `core/matching-engine.ts:115` adalah operasi sinkron yang mengiterasi seluruh order book untuk setiap market slot. Selama matching berjalan, NATS messages berikutnya mengantri di event loop. Tidak ada timeout atau batasan iterasi.

**9. Tidak ada index per wallet**
Tidak ada `Map<walletAddress, Set<orderId>>`. Self-match prevention di `core/matching-engine.ts:180` dilakukan dengan linear comparison per match iteration (`order.walletAddress.toLowerCase() === makerOrder.walletAddress.toLowerCase()`), bukan via lookup terstruktur.

**10. `loadFeeConfig()` dipanggil per match, tanpa caching**
`calculateMakerFee()` dan `calculateTakerFee()` di `utils/helpers.ts:200-217` memanggil `loadFeeConfig()` setiap invokasi. `loadFeeConfig()` membaca dari `process.env` setiap kali. **[INFERENSI]**: potensi overhead di volume tinggi.

---

### Area yang Tidak Bisa Dipastikan dari Kode Ini

1. **Schema DB aktual** — Schema DB dikomentari di `services/db/postgres-db-client.ts:28-54` tapi file migrasi tidak ada di direktori ini. Tidak bisa memverifikasi actual column constraints, foreign keys, dan indices.

2. **`db-writer-service.ts`** — File tidak dibaca lengkap dalam audit ini. Behavior penuh proses DB writer (batching, concurrency, PEL recovery untuk stale Redis entries) belum diverifikasi seluruhnya.

3. **Perilaku `functional-red-black-tree` saat key duplikat** — Jika dua order memiliki rate dan timestamp yang identis, komparator menghasilkan `0`. Tidak diketahui apakah library ini meng-handle duplikat key dengan benar atau silently drop salah satu.

4. **Recovery order expired dari snapshot** — Snapshot tidak menyimpan informasi validitas berdasarkan waktu. Jika engine mati lama, semua orders dari snapshot (termasuk yang sudah melewati maturity) akan di-restore tanpa pengecekan.

5. **Behavior saat `maxBufferSize` tercapai** — `recordMatch()` melempar error (`core/execution-engine.ts:103`). Perlu ditelusuri lebih lanjut apa yang terjadi pada NATS message yang memicu order tersebut dan apakah order tetap di book tanpa matchnya tercatat (`services/message-handlers.ts:288-293`).

6. **Settlement engine dan lock release** — Referensi ke `settlement-engine/src/settlement/database/lock-release.ts` ada di `CLAUDE.md` tapi file tersebut berada di luar direktori ini. Tidak bisa memverifikasi apakah lock release semantics masih sinkron dengan `insertMatch()` yang sudah menggunakan `user_balance.in_orders` (post-C4 schema).
