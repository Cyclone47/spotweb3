Third-party notices
===================

NNTP pipeline provenance
------------------------

This private branch does **not** vendor, copy, or modify source code from
`robinvdvleuten/php-nntp` / `rvdv/nntp`.

That package was evaluated during design as a modern PHP NNTP reference, but
the implementation committed here is original Spotweb code using PHP streams
directly:

- `Services_Nntp_PipelinedTransport`
- `Services_Nntp_PipelinedRecovery`
- related result/outcome/exception classes

Because no third-party NNTP source is bundled, there is no separate NNTP
third-party licence text to retain in this repository for this feature.

Reference evaluated, not used as source:

- https://github.com/robinvdvleuten/php-nntp
- evaluated commit: `d5c59c90f02a82ca09609f9a6e912f9d78f0faeb`

Browser Download Engine (`7z-wasm`)
-----------------------------------

The client-side browser download engine vendors prebuilt WebAssembly artifacts from
[`7z-wasm`](https://github.com/use-strict/7z-wasm) v1.2.0 (7-Zip 24.09 compiled to
WebAssembly via Emscripten) in `js/browser-download/vendor/`:

- `js/browser-download/vendor/7zz.umd.js`
- `js/browser-download/vendor/7zz.wasm`
- `js/browser-download/vendor/7z-License.txt` (GNU LGPL v2.1+ / BSD 3-clause / unRAR restriction)
- `js/browser-download/vendor/unRarLicense.txt` (unRAR decompression license)

The rest of the Browser Download Engine (`nzb-parser.js`, `yenc-decoder.js`,
`par2-engine.js`, `archive-extractor.js`, `nntp-client.js`, `storage-manager.js`,
`download-worker.js`, `download-manager.js`, `SpotPage_nntprelay.php`, and
`bin/nntp-relay.php`) is original first-party Spotweb code.
