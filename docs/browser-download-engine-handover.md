# Handover: a browser-based download engine for Spotweb

## User's proposed idea

Extend Spotweb so a user can download the actual content referenced by an NZB directly through the browser, similar to the download experience in desktop Spotnet.

The desired flow is:

1. Open Spotweb in the browser.
2. Choose a spot and select **Download in browser**.
3. Select a local destination folder using the browser's folder picker.
4. See download progress and, where required, verification, repair and extraction progress.
5. Find the completed files in the selected folder, without manually passing an NZB to another program.

The user is open to creating a new download core/engine, reusing existing code, compiling suitable libraries to WebAssembly, or investigating browser emulation where it offers a practical advantage.

## Firm requirement: the user installs nothing

The user explicitly states: **"I do not want to install anything."**

The delivered experience must work by visiting Spotweb in a normal browser. Do not require the user to install SABnzbd, NZBGet, desktop Spotnet, a companion service, a browser extension, a runtime, a certificate, an installed PWA, or another application. Do not require developer mode or experimental browser flags.

JavaScript and WebAssembly loaded automatically by the website are acceptable implementation mechanisms for a browser engine. Selecting a folder and granting the browser permission to write there are part of the requested experience.

The engine should execute downloading coordination, decoding and, where supported, repair/extraction in the browser. A server-side downloader with a web interface is a different architecture and does not automatically satisfy this request.

A server-side connection relay has been proposed, but the user has not explicitly approved installing or deploying additional server services. Treat that as an infrastructure proposal, not as permission to install anything on the user's machine or deploy production infrastructure. Investigate the existing hosting environment and explain any unavoidable server requirement before deployment. Do not quietly reinterpret "nothing to install" as permission to require installation elsewhere by the user.

## Freedom for the implementing AI agent

**The implementing agent is explicitly encouraged to find and use better-suited methods while working on this project.**

The architecture and libraries below are recommendations and research leads, not mandatory choices. Investigate alternatives, compare them with measurements, and change direction when evidence supports a better approach. This includes finding more suitable libraries, reusing additional code, replacing unsuitable dependencies, compiling selected algorithms, or developing custom components.

Preserve the user's intended experience and installation constraint. Document important decisions, why an alternative was selected, and the effect on browser support, performance, storage, privacy and hosting requirements. Routine implementation improvements do not need renewed approval. Changes that alter the user's requirements or introduce an installation/deployment obligation must be made explicit rather than assumed acceptable.

## Current workspace and research

* Spotweb workspace: `C:\githubs\spotweb`.
* Desktop reference cloned to: `C:\githubs\spotnet-classic-3`.
* Desktop repository: https://github.com/Cyclone47/spotnet-classic-3
* Detailed research and phased plan: [browser-download-engine-plan.md](browser-download-engine-plan.md).
* Research date: 2026-10-22.
* Current status: research and planning only. No browser download engine has been implemented, compiled or benchmarked.

The inspected desktop repository contains VB.NET/C# code and delegates downloads to SABnzbd. It is useful as a behavior reference, but does not supply a ready browser download core.

Spotweb already has NZB retrieval, permission checks and downloader integrations. Reuse appropriate existing behavior rather than rebuilding the indexer. Its current local-save handler writes an NZB on the PHP server; that is not the requested browser-local content download.

## Suggested architecture

Start by evaluating a browser-native coordinator written in TypeScript/JavaScript with Web Workers and selected WebAssembly modules:

```text
Spotweb -> authorized NZB and download UI
                         |
                         v
Usenet provider <-> connection relay <-> browser download engine
                                               |
                              decode / verify / repair / extract
                                               |
                                               v
                                    selected local folder
```

An ordinary browser website cannot open arbitrary NNTP/TLS sockets to a conventional Usenet server. WebAssembly or CPU emulation does not remove that restriction. A browser-compatible provider API could change the transport options; otherwise, a server relay is the proposed solution. Do not promise direct browser-to-NNTP connectivity without demonstrating a supported mechanism.

The proposed relay forwards article traffic rather than downloading and storing complete releases. It still carries all transferred bytes, consumes server bandwidth and needs authenticated access, bounded connections, restricted destinations and TLS validation. In the simplest design it terminates provider TLS and is trusted with credentials and article data. Do not describe that as end-to-end browser-to-provider secrecy.

Prefer keeping long-lived connections outside normal PHP request workers. Evaluate whether the existing host can provide the required transport without asking the user to install software. If no acceptable transport exists, report that limitation clearly.

## Reuse candidates and alternatives

These are unvalidated candidates, not dependencies already selected for production:

| Area | Candidate | Qualification |
| --- | --- | --- |
| yEnc and CRC32 | https://github.com/animetosho/rapidyenc | Incremental native routines; needs WASM evaluation and yEnc header handling |
| Archive extraction | https://github.com/nika-begiashvili/libarchivejs | Existing browser/WASM library; validate real multipart, encrypted and large-file workloads |
| RAR-specific extraction | https://github.com/YuJianrong/node-unrar.js or a custom upstream UnRAR binding | Existing wrapper documents lack of volume-archive support; not a complete unchanged solution |
| PAR2 repair | https://github.com/Parchive/par2cmdline | Investigate a WASM port with disk-backed I/O |
| Optimized PAR2 alternative | https://github.com/animetosho/par2cmdline-turbo | Native optimizations are not proof of browser performance |
| Relay implementation/reference | https://github.com/novnc/websockify | Needs appropriate authentication, NNTP TLS and deployment controls |
| Larger existing core | https://github.com/nzbgetcom/nzbget | Compare a bounded WASM porting experiment against a new browser coordinator |
| Emulation | https://github.com/copy/v86 | Experimental option; assess OS image, virtual disk, network bridge and performance costs |

Porting SABnzbd through Pyodide is another research option, but its runtime and native dependency assumptions make it a less attractive initial direction. No complete, production-ready browser Usenet engine was verified during the research. Re-check the ecosystem: better options may exist or appear.

Check exact upstream versions, source licenses and dependency distribution requirements before adopting code. Native library performance claims must not be presented as measured browser performance.

## Main risks to resolve early

* **Large files:** process bounded chunks; do not hold a complete release in RAM or a memory-backed WASM filesystem.
* **Disk access:** the selected user folder and origin-private file system (OPFS) are different. Native-style synchronous access is available in OPFS workers, not directly in any selected directory. Evaluate storage adapters and extra temporary disk usage.
* **Resume:** persist job identity, checksums and completed-part checkpoints. Prove durable writes and recovery after interruption rather than assuming an open stream is committed.
* **Repair/extraction:** test multipart RAR, passwords, missing articles, corrupt data and insufficient PAR2 recovery blocks. Do not equate archive format support with complete release compatibility.
* **Browser lifecycle:** closing the browser or sleeping the device stops browser execution. Provide later resume; do not promise unattended desktop-service behavior.
* **Browser support:** desktop Chrome/Edge over HTTPS is the proposed first target for folder access. Detect actual capabilities and report unsupported cases clearly. Expand support when feasible without violating the installation constraint.
* **Integration:** an active download must not disappear because the user navigates to another Spotweb page. A dedicated downloads page is a candidate solution.

## Proposed implementation plan

1. Inspect repository instructions and existing deployment/integration points. Reassess available libraries and transport options. Select the smallest experiment that can disprove the proposed architecture early.
2. Build a feasibility prototype using generated fixtures and a controlled NNTP test server. Transfer and verify a large file (initial target: 10 GB) with bounded memory. Separately demonstrate multipart extraction and PAR2 repair using disk-backed data. Record throughput, peak memory and temporary disk usage.
3. Choose the architecture based on those results. If a candidate fails, investigate alternatives before expanding the UI or promising desktop parity.
4. Implement the download core: NZB parsing, bounded concurrency, NNTP framing, yEnc validation, checksums, part assembly, retries, cancellation, progress and clear failure states.
5. Implement persistence and recovery: pause/resume, reload/restart recovery, connection failures, folder permission changes, storage quota and disk-full handling.
6. Integrate validated repair/extraction modules. Cover realistic archive variants, safe output paths, collisions, passwords and unsupported cases.
7. Add **Download in browser**, destination selection and queue/progress UI to Spotweb. Keep NZB export available. Distinguish queued, downloaded, verified and completed states.
8. Verify the complete workflow in supported browsers and document actual capabilities and limitations. Deploy only within the user's authorized infrastructure scope.

## Completion criteria

* A user can open Spotweb, select a spot and a local folder, and receive the actual downloaded content without installing software.
* The engine performs the claimed work in the browser; any server involvement is clearly documented.
* Large-file processing uses bounded memory and has measured disk requirements.
* Interrupted jobs can resume safely within documented limits.
* Supported repair and extraction cases work end to end, with understandable errors for unsupported or unrecoverable cases.
* Existing Spotweb access controls are respected, and the relay cannot become an unrestricted public proxy.
* Results clearly distinguish demonstrated behavior from planned functionality.

The next engineering deliverable is a measured feasibility prototype. The agent is free to improve this plan throughout implementation while preserving the user's requirements.
