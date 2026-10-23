# Browser download engine: feasibility and implementation plan

Research date: 2026-10-22. Status: proposal; no engine implemented or benchmarked.

## Objective

Download the content described by a Spotweb NZB into a user-selected local folder, with downloading, decoding, verification, repair and extraction running in the browser. No downloader, extension or companion application is installed on the user's device.

The proposed initial target is desktop Chrome/Edge over HTTPS. Browser capability detection is required; unsupported browsers must not be presented with a working folder-download promise.

## Recommendation

Build a TypeScript queue and storage layer, reuse suitable C/C++ algorithms through WebAssembly, and deploy a small authenticated NNTP/TLS relay alongside Spotweb. Start with a feasibility prototype that proves large-file storage, multipart extraction and repair before committing to full implementation.

An ordinary website cannot open arbitrary TCP/TLS connections to a news server. WebAssembly and CPU emulation do not remove this restriction. A relay is necessary unless the selected provider exposes a suitable browser-accessible API. The relay is server software; users install nothing.

## Options

| Option | Reuse | Main work | Assessment |
| --- | --- | --- | --- |
| New browser coordinator + reusable WASM modules | Decoder, repair and extraction algorithms | Queue, transport, disk adapters, recovery, UI | Recommended; browser behavior is explicit and testable |
| Port NZBGet to WASM | Mature C++ download and verification logic | Replace/adapt sockets, file I/O, threading, process execution and lifecycle | Worth a bounded porting experiment, not assumed to compile unchanged |
| Port SABnzbd through Pyodide | Python application logic | Browser runtime compatibility, dependencies, networking, native tools and storage | More runtime layers; weak fit for this project |
| Run Linux/downloader under v86 | Existing native program inside emulated OS | Guest image, network relay, disk bridge, lifecycle and UI integration | Research/demo option; substantial overhead and complexity |
| Server downloader with browser delivery | Existing complete downloader | Job API and file delivery | Easier alternative, but does not meet the requested browser-engine architecture |

No complete, production-ready in-browser Usenet engine was verified during this research. Projects advertising a web UI do not necessarily run their engine in the browser.

## Reusable components

* **rapidyenc:** C-compatible incremental yEnc decoding and CRC32. It does not parse yEnc headers. Candidate for a WASM build; native SIMD speed claims are not browser benchmarks. Its README lists CC0/public-domain code plus separately licensed CRC components. https://github.com/animetosho/rapidyenc
* **libarchive.js:** an existing browser/WebAssembly archive library supporting formats including RAR4, RAR5, 7z and ZIP. Candidate for initial extraction tests. Format support alone does not prove encrypted multipart RAR or bounded-memory extraction works for our workload. https://github.com/nika-begiashvili/libarchivejs
* **node-unrar.js:** existing Emscripten UnRAR wrapper. Its documented lack of volume-archive support rules it out as a complete, unchanged solution for typical multipart releases. Useful reference; investigate a different wrapper or custom upstream UnRAR binding. https://github.com/YuJianrong/node-unrar.js
* **par2cmdline/libpar2:** candidate repair implementation to port. Also evaluate par2cmdline-turbo, but native optimizations may not transfer to WASM. No ready browser build was verified. ParPar alone is primarily a PAR2 creation tool, not the complete repair solution. https://github.com/Parchive/par2cmdline and https://github.com/animetosho/par2cmdline-turbo
* **websockify:** established WebSocket-to-TCP bridge implementation/reference. A production deployment still needs NNTP TLS handling, authenticated sessions, restricted destinations and connection limits. https://github.com/novnc/websockify
* **NZBGet:** reference or alternative port target for scheduling, article handling and recovery. https://github.com/nzbgetcom/nzbget

Record exact versions, upstream licenses, dependencies and distribution requirements before incorporating code. Spotweb declares MIT; selected upstream projects have differing licenses, including GPL and UnRAR-specific terms. This research has not completed a license compatibility review.

## Architecture

Spotweb supplies an authorized NZB and short-lived relay authorization. A dedicated browser download page owns the queue, workers and persistent job state. An optional separate service in Docker Compose relays binary article traffic between secure WebSockets and configured NNTP/TLS servers.

The browser parses NZBs, schedules requests, decodes article bytes, checks part checksums and offsets, assembles files, requests additional recovery articles when required, repairs and extracts locally. Use bounded queues and explicit backpressure so a fast network cannot exhaust browser memory.

The relay has no full-release staging requirement. It forwards all downloaded bytes, so its ingress/egress bandwidth and provider connection limits remain real constraints. Start with TLS terminated at the relay: this means the relay is trusted with provider credentials and plaintext article data. Do not claim end-to-end browser-to-provider secrecy. Browser-side TLS over a raw tunnel would be a separate, more complex option.

Restrict relay destinations to approved news endpoints, validate TLS certificates, bind authorization to Spotweb users, enforce per-user connection limits, and avoid logging credentials. Never expose an arbitrary public TCP proxy.

## Storage is an early feasibility gate

The user-visible selected directory and the browser's origin-private file system (OPFS) are different. Synchronous file handles suitable for native WASM I/O operate in OPFS inside dedicated workers, not directly on arbitrary selected directories.

Prototype two approaches: bounded temporary chunks/checkpoints in OPFS followed by output to the selected folder; and asynchronous selected-folder I/O exposed to WASM through an adapter. Evaluate extra disk usage, browser quota, commit behavior, crash recovery and performance before selecting the production strategy. A large writable stream must not be treated as crash-durable before its actual commit semantics are proven.

Store the queue manifest and completed-part/checksum state in IndexedDB. Request persistent storage where supported, check available quota, and handle permission revocation and disk-full errors. Do not store a release as one ArrayBuffer or assume a memory-backed WASM filesystem scales to tens of gigabytes.

## Implementation stages and acceptance gates

1. **Feasibility prototype.** Use generated fixtures and a controlled NNTP test server. Retrieve a known multipart file through the relay, decode it in a worker and verify its final hash. Benchmark at least a 10 GB generated file with a fixed memory budget. Independently prove multipart RAR extraction and PAR2 repair of deliberately missing/corrupt blocks using disk-backed storage. Record browser/version, memory, disk amplification and throughput. Failure here changes the architecture before UI work grows.
2. **Core downloader.** Implement NZB validation, bounded concurrent connections, streaming NNTP framing, yEnc header/trailer validation, CRC32, part placement, retry/backoff, cancellation and accurate failure states. Reject malformed offsets and unsafe filenames. Initially support complete downloads with clear reporting when repair is required.
3. **Durability.** Persist job identity and part checkpoints. Test tab reload, browser termination, relay restart, network loss, quota exhaustion and destination permission changes. Revalidate saved data before resuming. Browser closure stops execution; persistence enables later resume, not background continuation.
4. **Repair and extraction.** Integrate the validated WASM modules. Cover RAR4/RAR5, multipart and password-protected fixtures, insufficient recovery blocks, obfuscated names, output collisions and path traversal. Fetch only needed PAR2 recovery data where possible. Report unsupported formats honestly.
5. **Spotweb integration.** Add an explicit browser-download action and dedicated downloads page; retain the NZB export option. Reuse existing NZB retrieval and permission checks, but distinguish queued, transferred, verified and completed states. Ordinary Spotweb navigation should not accidentally destroy the page owning active downloads.
6. **Release validation.** Test the full click-to-folder workflow on target Chrome/Edge versions, measure multi-job resource use, document host deployment requirements, and verify unsupported-browser behavior. Publish supported archive/repair cases and measured limitations rather than assuming desktop parity.

## Existing Spotweb integration points

* `lib/services/Actions/Services_Actions_DownloadNzb.php`: NZB retrieval, permission checks and current handled/download-history behavior.
* `lib/services/NzbHandler/Services_NzbHandler_Factory.php`: download action selection.
* `templates/modern/spotinfo.inc.php`: NZB/download entry points.
* `templates/modern/js/scripts.js`: existing client download actions.
* `docker-compose.yml`: deployment integration for a long-running relay service.

Keep long-lived NNTP sessions out of normal PHP request workers. PHP remains responsible for Spotweb authorization and metadata; the new browser engine owns download execution.

## Practical limits and supporting documentation

* No reliable continuation while the browser is closed or the device is asleep. Installing the page as a PWA does not remove these constraints.
* HTTPS and user interaction are required for the directory picker; support is not universal: https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker
* Ordinary browser sockets still require a bridge, including Emscripten ports: https://emscripten.org/docs/porting/networking.html
* Disk-backed synchronous browser I/O has OPFS/worker restrictions: https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle
* Multithreaded Emscripten builds require suitable cross-origin isolation headers. Validate effects on existing Spotweb resources, or isolate the download application: https://emscripten.org/docs/porting/pthreads.html
* CPU emulation exists but is not a validated downloader solution: https://github.com/copy/v86
* Python runtime compatibility must be checked rather than assuming native SABnzbd works unchanged: https://pyodide.org/en/stable/usage/wasm-constraints.html

The immediate proposed deliverable is the feasibility prototype and measured results. A reliable completion estimate for desktop-like repair/extraction depends on those results.
