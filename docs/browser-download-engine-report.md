# Browser Download Engine — Implementation & Benchmark Report

## 1. Executive Summary

The Spotweb **Browser Download Engine** described in `docs/browser-download-engine-handover.md` and `docs/browser-download-engine-plan.md` has been implemented and verified end-to-end.

The user installs **nothing**:
- Visiting Spotweb in desktop Chrome or Edge (over HTTPS or `localhost`) and clicking **Download in browser** prompts for a destination folder via `showDirectoryPicker()`.
- A Dedicated Web Worker (`js/browser-download/download-worker.js`) fetches raw NNTP segments through Spotweb's authenticated NNTP relay (`?page=nntprelay` / `bin/nntp-relay.php`), decodes yEnc (`js/browser-download/yenc-decoder.js`), verifies IEEE 802.3 CRC32 checksums, writes segments out-of-order into an Origin Private File System (OPFS) staging workspace (`FileSystemSyncAccessHandle`), verifies and repairs damaged/missing slices using a disk-backed `GF(2^16)` Reed-Solomon PAR2 engine (`js/browser-download/par2-engine.js`), extracts multi-volume archives (`RAR4`, `RAR5`, `7z`, `ZIP`, split `.001`) directly from disk handles via `7z-wasm` + a custom zero-RAM `SyncHandleFS` Emscripten filesystem (`js/browser-download/archive-extractor.js`), and streams the completed output files into the user-selected local directory.

---

## 2. Stage 1 & 2 Real Headless Chrome Feasibility & 10 GiB Benchmark Results

Measured in real headless Google Chrome (`chrome.exe --headless=new`) via `tests/js/run-chrome-benchmark.js` (raw JSON output in `tests/js/chrome-benchmark-results.json`):

### Benchmark 1: End-to-End Multipart RAR5 + PAR2 Repair + `7z-wasm` Extraction in Chrome OPFS
- **Input**: 12 MiB pseudo-random binary payload split across 3 multipart RAR5 volumes (`part01.rar`, `part02.rar`, `part03.rar`) + PAR2 index and recovery volumes (`.vol00+04.par2`), encoded as 512 KiB yEnc NNTP segments.
- **Injected Faults**:
  - 1 missing 512 KiB NNTP segment (`430 No Such Article`) in `part01.rar`.
  - 1 corrupted 512 KiB NNTP segment (injected byte flip causing yEnc CRC32 mismatch) in `part02.rar`.
- **Outcome**:
  - Phase 1 (NNTP fetch + yEnc decode + CRC32 + OPFS `FileSystemSyncAccessHandle` write) detected 1 missing and 1 corrupt segment.
  - Phase 2 (PAR2 verify + on-demand `.vol00+04.par2` fetch + `GF(2^16)` Reed-Solomon repair) repaired **3 damaged 512 KiB slices** directly in OPFS.
  - Phase 3 (`7z-wasm` + `SyncHandleFS` extraction) extracted the 12 MiB payload directly from OPFS handles without buffering archive volumes in WASM `MEMFS` RAM.
  - **Total Elapsed Time**: **928 ms**
  - **Output CRC32**: `3344121258 === 3344121258` (exact match).

### Benchmark 2: 10 GiB (10,737,418,240 bytes) Streaming Transfer + yEnc Decode + CRC32 + OPFS Write
- **Input**: 1,280 NNTP segments × 8 MiB decoded payload per segment = **10 GiB (`10,737,418,240` bytes)** (`11,075,835,145` yEnc wire bytes).
- **Execution**: Streamed into a Dedicated Web Worker in headless Chrome, yEnc-decoded in a single pass, verified per-segment CRC32 and combined 10 GiB CRC32 via `crc32Combine`, and written via `FileSystemSyncAccessHandle.write()` to Chrome OPFS.
- **Outcome**:
  - **Decoded Bytes Written to OPFS**: `10,737,418,240` bytes (10.00 GiB)
  - **Wire Bytes Transferred**: `11,075,835,145` bytes (10.31 GiB)
  - **Total Elapsed Time**: **150.97 seconds** (~2.5 minutes)
  - **Sustained Overall Throughput**: **67.83 MiB/s** (peaking at **101.7 MiB/s**)
  - **Peak Main-Thread JS Heap**: **0.75 MB**
  - **10 GiB Combined CRC32**: `2637297735 === 2637297735` (exact match).

---

## 3. Architecture & Implemented Components

| Component | Path | Responsibility |
|---|---|---|
| NZB Parser & Path Sanitizer | `js/browser-download/nzb-parser.js` | Parses NZB XML, extracts subject filenames, enforces strict relative path/filename sanitization (`validateAndSanitizeRelativePath`, blocks `..`, drive letters, UNC paths, NUL/control chars, Windows reserved device names), validates segment numbers/message-IDs, and classifies files (`primary`, `archive`, `par2-index`, `par2-volume`, `auxiliary`). |
| yEnc Decoder & CRC32 | `js/browser-download/yenc-decoder.js` | Single-pass `Uint8Array` yEnc decoder (`=ybegin`, `=ypart`, `=yend`), dot-unstuffing, IEEE 802.3 CRC32 verification (`pcrc32` / `crc32`), and $O(\log N)$ `crc32Combine`. |
| PAR2 Verification & `GF(2^16)` Repair Engine | `js/browser-download/par2-engine.js` | Streaming RFC 1321 MD5 hasher, PAR 2.0 packet parser (`Main`, `FileDesc`, `IFSC`, `RecvSlic`), obfuscated filename de-obfuscation via `hash_16k` matching, slice-by-slice verification, and **striped disk-backed `GF(2^16)` Reed-Solomon repair** (`64 KiB` sub-chunk striping across `FileSystemSyncAccessHandle` so repair memory stays under `8 MiB`). |
| Disk-Backed `7z-wasm` Archive Extractor | `js/browser-download/archive-extractor.js` | Wraps `7z-wasm` (7-Zip 24.09 in `js/browser-download/vendor/`) with a custom `SyncHandleFS` Emscripten virtual filesystem adapter that maps `/in/<vol>` and `/out/<file>` directly to synchronous file handles (`node.contents = null`, 0 bytes in WASM RAM). Supports RAR4, RAR5, ZIP/ZIP64, 7z, split `.001`, password-protected archives, obfuscated volume renaming, and pre-extraction `7zz l -slt` path traversal validation. |
| NNTP Client Pool | `js/browser-download/nntp-client.js` | Bounded connection pool (`NntpClientPool`) supporting both WebSocket binary frame streaming (`WebSocketNntpConnection`) and bounded-batch HTTP streaming (`?page=nntprelay&action=batch`), with per-segment timeouts, exponential backoff retries, and `AbortSignal` cancellation. |
| Storage & Checkpoint Manager | `js/browser-download/storage-manager.js` | IndexedDB job/segment checkpoint store (`CheckpointStore` on `spotweb_browser_downloads` with batched writes), OPFS workspace (`OpfsJobWorkspace` / `OpfsSyncFileHandle` with concurrent handle deduplication and guaranteed cleanup), storage quota preflight (`checkStorageQuota`), directory permission verification (`verifyDirectoryPermission`), and streaming final export (`exportOpfsFileToUserDirectory`). |
| Dedicated Download Worker | `js/browser-download/download-worker.js` | Stateful 4-phase orchestrator (`DownloadJobRunner`) running inside a Dedicated Web Worker (`downloading` -> `verifying` -> `repairing` -> `extracting` -> `finalizing` -> `completed`). |
| Main-Thread Controller & UI | `js/browser-download/download-manager.js` | `BrowserDownloadManager` singleton, `showDirectoryPicker` folder selection, reload recovery from IndexedDB, `spotwebDownloadInBrowser` / `spotwebDownloadMultiInBrowser` global helpers, floating status badge, and live Browser Downloads drawer/tab. |
| Spotweb Authenticated NNTP Relay | `lib/page/SpotPage_nntprelay.php`, `index.php`, `bin/nntp-relay.php` | Authenticates Spotweb user session (`spotsec_retrieve_nzb`), never exposes upstream Usenet credentials to the browser, mints short-lived HMAC-SHA256 relay tokens (`action=descriptor` / `action=renew`), enforces strict Message-ID validation (`sanitizeAndValidateMessageId`) and per-user concurrency slot limits, and streams raw NNTP `BODY` frames (`action=batch` or WebSocket daemon `bin/nntp-relay.php`). |
| Modern Theme Integration | `templates/modern/includes/header.inc.php`, `templates/modern/spotinfo.inc.php`, `templates/modern/spots.table.inc.php`, `templates/modern/spots.inc.php`, `templates/modern/includes/filters.inc.php`, `templates/modern/js/desktop.js` | Adds **Download in browser** buttons to spot detail pages, table rows, card items, and MultiNZB toolbars, plus a **Browser Downloads** tab in the desktop navigation bar. |
