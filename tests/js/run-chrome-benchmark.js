/**
 * Spotweb Browser Download Engine - Real Headless Chrome Feasibility & Benchmark Suite
 *
 * Launches real Google Chrome (`--headless=new --enable-precise-memory-info`) with an isolated
 * `--user-data-dir`, runs the Dedicated Web Worker (`download-worker.js`) against a local
 * controlled NNTP test server, and measures:
 *   1. End-to-End Multipart RAR5 + PAR2 GF(2^16) Repair + 7z-wasm Zero-RAM Extraction in real OPFS
 *   2. 10 GiB (10,737,418,240 bytes) Streaming NNTP + yEnc Decode + CRC32 Verification + OPFS SyncAccessHandle Write
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const YencDecoder = require('../../js/browser-download/yenc-decoder.js');
const Par2Engine = require('../../js/browser-download/par2-engine.js');
const NntpClient = require('../../js/browser-download/nntp-client.js');

const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

function findBrowserExecutable() {
    for (const p of CHROME_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error('Could not find Chrome or Edge executable for browser benchmark');
}

// ============================================================================
// RAR5 Fixture Generator for Browser E2E Repair + Extraction Test
// ============================================================================
function writeVint(val) {
    const bytes = [];
    let v = BigInt(val);
    do {
        let b = Number(v & 0x7fn);
        v >>= 7n;
        if (v > 0n) b |= 0x80;
        bytes.push(b);
    } while (v > 0n);
    return Buffer.from(bytes);
}

function makeRar5Header(headerType, headerFlags, extraBytes, bodyBytes, dataAreaSize) {
    const extraBuf = extraBytes ? Buffer.from(extraBytes) : Buffer.alloc(0);
    const bodyBuf = bodyBytes ? Buffer.from(bodyBytes) : Buffer.alloc(0);
    let flags = headerFlags;
    const flagExtras = [];
    if (extraBuf.length > 0) {
        flags |= 0x0001;
        flagExtras.push(writeVint(extraBuf.length));
    }
    if (dataAreaSize !== undefined && dataAreaSize !== null) {
        flags |= 0x0002;
        flagExtras.push(writeVint(dataAreaSize));
    }
    const contentAfterSize = Buffer.concat([
        writeVint(headerType),
        writeVint(flags),
        ...flagExtras,
        bodyBuf,
        extraBuf
    ]);
    const sizeVint = writeVint(contentAfterSize.length);
    const toCrc = Buffer.concat([sizeVint, contentAfterSize]);
    const crc = YencDecoder.crc32(toCrc);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32LE(crc >>> 0, 0);
    return Buffer.concat([crcBuf, toCrc]);
}

function createRar5Volumes(innerFilename, payloadBytes, numVolumes) {
    const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
    const fullCrc = YencDecoder.crc32(payloadBytes);
    const nameBytes = Buffer.from(innerFilename, 'utf8');
    const chunkSize = Math.ceil(payloadBytes.length / numVolumes);
    const volumes = [];

    for (let i = 0; i < numVolumes; i++) {
        const start = i * chunkSize;
        const end = Math.min(payloadBytes.length, start + chunkSize);
        const chunk = Buffer.from(payloadBytes.subarray(start, end));
        const isFirst = (i === 0);
        const isLast = (i === numVolumes - 1);

        let arcFlags = 0x0001;
        let volNumVint = Buffer.alloc(0);
        if (i > 0) {
            arcFlags |= 0x0002;
            volNumVint = writeVint(i);
        }
        const mainHdr = makeRar5Header(1, 0, null, Buffer.concat([writeVint(arcFlags), volNumVint]), null);

        let fHdrFlags = 0;
        if (!isFirst) fHdrFlags |= 0x0008;
        if (!isLast) fHdrFlags |= 0x0010;

        const fileFlags = isLast ? 0x0004 : 0x0000;
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32LE(fullCrc >>> 0, 0);
        const fileBody = Buffer.concat([
            writeVint(fileFlags),
            writeVint(payloadBytes.length),
            writeVint(0x20),
            isLast ? crcBuf : Buffer.alloc(0),
            writeVint(0),
            writeVint(0),
            writeVint(nameBytes.length),
            nameBytes
        ]);
        const fileHdr = makeRar5Header(2, fHdrFlags, null, fileBody, chunk.length);
        const endArcFlags = isLast ? 0 : 0x0001;
        const endHdr = makeRar5Header(5, 0, null, writeVint(endArcFlags), null);

        const volName = `release.part${String(i + 1).padStart(2, '0')}.rar`;
        volumes.push({
            name: volName,
            data: new Uint8Array(Buffer.concat([RAR5_SIG, mainHdr, fileHdr, chunk, endHdr]))
        });
    }
    return volumes;
}

// ============================================================================
// Build Fixtures for Benchmark 1 (E2E RAR5 + PAR2 Repair) & Benchmark 2 (10 GiB)
// ============================================================================
function buildFixtures() {
    console.log('[Setup] Preparing E2E RAR5 + PAR2 fixtures and 10 GiB yEnc generator...');

    // 1. E2E Archive + PAR2 fixture (12 MiB payload in 3 RAR5 volumes)
    const e2ePayloadSize = 12 * 1024 * 1024; // 12 MiB
    const e2ePayload = new Uint8Array(e2ePayloadSize);
    for (let i = 0; i < e2ePayloadSize; i++) {
        e2ePayload[i] = (i * 73 + (i >> 9) * 19 + 11) & 0xff;
    }
    const e2eExpectedCrc = YencDecoder.crc32(e2ePayload);

    const rar5Vols = createRar5Volumes('BenchmarkVideo_1080p.mkv', e2ePayload, 3);
    const par2SliceSize = 262144; // 256 KiB slices -> ~48 slices total
    const par2Vols = Par2Engine.createPar2Volumes(
        rar5Vols.map((v) => ({ filename: v.name, data: v.data })),
        par2SliceSize,
        4 // 4 recovery slices (1 MiB parity)
    );

    const e2eArticles = new Map();
    const e2eNzbFiles = [];
    const e2eSegSize = 512 * 1024; // 512 KiB per segment

    const allE2eFiles = [
        ...rar5Vols.map((v) => ({ filename: v.name, data: v.data })),
        { filename: 'release.par2', data: par2Vols.indexPar2 },
        { filename: 'release.vol00+04.par2', data: par2Vols.volumePar2 }
    ];

    allE2eFiles.forEach((f, fIdx) => {
        const totalParts = Math.ceil(f.data.length / e2eSegSize);
        const fCrc = YencDecoder.crc32(f.data);
        const segXml = [];
        for (let p = 0; p < totalParts; p++) {
            const offset = p * e2eSegSize;
            const slice = f.data.subarray(offset, Math.min(f.data.length, offset + e2eSegSize));
            const msgId = `e2e.f${fIdx}.p${p + 1}@bench.spotweb`;
            const article = YencDecoder.encodeYencArticle(slice, {
                filename: f.filename,
                totalSize: f.data.length,
                part: p + 1,
                totalParts,
                offset,
                fileCrc32: p === totalParts - 1 ? fCrc : undefined
            });
            e2eArticles.set(msgId, { status: 222, body: article });
            segXml.push(`<segment bytes="${slice.length}" number="${p + 1}">${msgId}</segment>`);
        }
        e2eNzbFiles.push(`
  <file poster="bench@spotweb.local" date="1700000000" subject="[0${fIdx + 1}/05] - &quot;${f.filename}&quot; yEnc (1/${totalParts})">
    <groups><group>alt.binaries.benchmark</group></groups>
    <segments>${segXml.join('')}</segments>
  </file>`);
    });

    // Simulate 1 missing 512 KiB segment (= 2 PAR2 slices) in release.part01.rar
    e2eArticles.set('e2e.f0.p2@bench.spotweb', { status: 430, body: new Uint8Array(0) });
    // And corrupt 1 byte in release.part02.rar segment 3 (= 1 damaged PAR2 slice; total 3 damaged slices <= 4 recovery blocks)
    const corruptArt = new Uint8Array(e2eArticles.get('e2e.f1.p3@bench.spotweb').body);
    corruptArt[200] ^= 0xff;
    e2eArticles.set('e2e.f1.p3@bench.spotweb', { status: 222, body: corruptArt });

    const e2eNzbXml = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head><meta type="title">E2E RAR5 + PAR2 Benchmark</meta></head>
  ${e2eNzbFiles.join('\n')}
</nzb>`;

    // 2. 10 GiB (10,737,418,240 bytes) Streaming Transfer Fixture
    // 1,280 segments * 8 MiB (8,388,608 bytes) = 10,737,418,240 bytes (10 GiB)
    const TEN_GB_PART_SIZE = 8 * 1024 * 1024; // 8 MiB
    const TEN_GB_TOTAL_PARTS = 1280;
    const TEN_GB_TOTAL_BYTES = TEN_GB_PART_SIZE * TEN_GB_TOTAL_PARTS; // 10,737,418,240

    const raw8MbChunk = new Uint8Array(TEN_GB_PART_SIZE);
    for (let i = 0; i < TEN_GB_PART_SIZE; i++) {
        raw8MbChunk[i] = (i * 41 + (i >> 11) * 13 + 7) & 0xff;
    }
    const chunkCrc = YencDecoder.crc32(raw8MbChunk);
    const chunkCrcHex = (chunkCrc >>> 0).toString(16).padStart(8, '0');

    // Compute full 10 GiB expected CRC32 by combining 1,280 part CRCs
    let full10GbCrc = 0;
    for (let p = 0; p < TEN_GB_TOTAL_PARTS; p++) {
        full10GbCrc = p === 0
            ? chunkCrc
            : YencDecoder.crc32Combine(full10GbCrc, chunkCrc, TEN_GB_PART_SIZE);
    }

    // Pre-encode a single 8 MiB yEnc article and extract just the encoded body lines
    const sampleEncoded = YencDecoder.encodeYencArticle(raw8MbChunk, {
        filename: 'benchmark-10gb.bin',
        totalSize: TEN_GB_TOTAL_BYTES,
        part: 1,
        totalParts: TEN_GB_TOTAL_PARTS,
        offset: 0
    });
    const sampleBuf = Buffer.from(sampleEncoded.buffer, sampleEncoded.byteOffset, sampleEncoded.byteLength);
    const firstCrLf = sampleBuf.indexOf('\r\n');
    const secondCrLf = sampleBuf.indexOf('\r\n', firstCrLf + 2);
    const lastYend = sampleBuf.lastIndexOf('\r\n=yend ');
    const preEncodedYencBody = sampleBuf.subarray(secondCrLf + 2, lastYend);

    function build10GbArticle(partNumber) {
        const offset = (partNumber - 1) * TEN_GB_PART_SIZE;
        const begin = offset + 1;
        const end = offset + TEN_GB_PART_SIZE;
        const crcSuffix = partNumber === TEN_GB_TOTAL_PARTS
            ? ` crc32=${(full10GbCrc >>> 0).toString(16).padStart(8, '0')}`
            : '';
        const hdr = Buffer.from(
            `=ybegin part=${partNumber} total=${TEN_GB_TOTAL_PARTS} line=128 size=${TEN_GB_TOTAL_BYTES} name=benchmark-10gb.bin\r\n` +
            `=ypart begin=${begin} end=${end}\r\n`,
            'ascii'
        );
        const trl = Buffer.from(
            `\r\n=yend size=${TEN_GB_PART_SIZE} part=${partNumber} pcrc32=${chunkCrcHex}${crcSuffix}\r\n`,
            'ascii'
        );
        return Buffer.concat([hdr, preEncodedYencBody, trl]);
    }

    const tenGbSegXml = [];
    for (let p = 1; p <= TEN_GB_TOTAL_PARTS; p++) {
        tenGbSegXml.push(`<segment bytes="${TEN_GB_PART_SIZE}" number="${p}">10gb.p${p}@bench.spotweb</segment>`);
    }
    const tenGbNzbXml = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head><meta type="title">10 GiB Feasibility Benchmark</meta></head>
  <file poster="bench@spotweb.local" date="1700000000" subject="[1/1] - &quot;benchmark-10gb.bin&quot; yEnc (1/${TEN_GB_TOTAL_PARTS})">
    <groups><group>alt.binaries.benchmark</group></groups>
    <segments>${tenGbSegXml.join('')}</segments>
  </file>
</nzb>`;

    return {
        e2eNzbXml,
        e2eArticles,
        e2eExpectedSize: e2ePayloadSize,
        e2eExpectedCrc: e2eExpectedCrc >>> 0,
        tenGbNzbXml,
        tenGbExpectedSize: TEN_GB_TOTAL_BYTES,
        tenGbExpectedCrc: full10GbCrc >>> 0,
        build10GbArticle
    };
}

// ============================================================================
// HTML Harness Served to Headless Chrome
// ============================================================================
function getBenchmarkHtml(fixtures) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Spotweb Browser Download Benchmark</title></head>
<body>
<script>
async function postLog(msg) {
    try {
        await fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msg })
        });
    } catch (_) {}
}

async function runBenchmarkInWorker() {
    const workerCode = \`
        importScripts(
            location.origin + '/js/browser-download/vendor/7zz.umd.js',
            location.origin + '/js/browser-download/nzb-parser.js',
            location.origin + '/js/browser-download/yenc-decoder.js',
            location.origin + '/js/browser-download/par2-engine.js',
            location.origin + '/js/browser-download/archive-extractor.js',
            location.origin + '/js/browser-download/nntp-client.js',
            location.origin + '/js/browser-download/storage-manager.js',
            location.origin + '/js/browser-download/download-worker.js'
        );

        self.addEventListener('message', async (ev) => {
            const msg = ev.data || {};
            if (msg.type !== 'RUN_BENCHMARKS') return;
            try {
                const results = {};

                // ------------------------------------------------------------
                // Benchmark 1: E2E RAR5 + PAR2 GF(2^16) Repair + 7z-wasm Extract in OPFS
                // ------------------------------------------------------------
                self.postMessage({ type: 'LOG', text: 'Starting Benchmark 1: Multipart RAR5 + PAR2 Repair + 7z-wasm Extraction in Chrome OPFS...' });
                const t0E2e = performance.now();
                let e2eStates = [];
                let e2ePeakHeap = 0;

                const e2eWorkspace = await self.SpotwebStorageManager.openOpfsJobWorkspace('bench_e2e_rar5');
                const e2eRunner = new self.SpotwebDownloadWorker.DownloadJobRunner({
                    jobId: 'bench_e2e_rar5',
                    nzbXml: msg.e2eNzbXml,
                    relayConfig: {
                        mode: 'http',
                        httpBatchUrl: location.origin + '/api/nntp-batch',
                        maxConnections: 4,
                        batchSize: 4
                    },
                    workspace: e2eWorkspace,
                    wasmUrl: location.origin + '/js/browser-download/vendor/7zz.wasm',
                    skipExportToDir: true,
                    keepWorkspaceOnComplete: true,
                    onUpdate: (snap) => {
                        if (e2eStates[e2eStates.length - 1] !== snap.state) {
                            e2eStates.push(snap.state);
                        }
                        if (snap.peakMemoryBytes > e2ePeakHeap) {
                            e2ePeakHeap = snap.peakMemoryBytes;
                        }
                    }
                });

                await e2eRunner.run();
                const e2eElapsedMs = Math.round(performance.now() - t0E2e);

                // Verify extracted file in Chrome OPFS
                const extractedList = await e2eWorkspace.listFiles('extracted');
                if (extractedList.length !== 1) {
                    throw new Error('Expected 1 extracted file in OPFS, got ' + extractedList.length);
                }
                const extHandle = await e2eWorkspace.openSyncHandle('extracted', extractedList[0].name);
                const extSize = extHandle.getSize();
                const extBuf = new Uint8Array(extSize);
                extHandle.read(extBuf, { at: 0 });
                const extCrc = self.SpotwebYencDecoder.crc32(extBuf) >>> 0;
                await e2eWorkspace.destroy();
                await e2eRunner.checkpointStore.deleteJob('bench_e2e_rar5');

                results.e2e = {
                    elapsedMs: e2eElapsedMs,
                    states: e2eStates,
                    missingSegments: e2eRunner.missingSegments,
                    corruptSegments: e2eRunner.corruptSegments,
                    repairedSlices: e2eRunner.repairedSlices,
                    extractedFile: extractedList[0].name,
                    extractedSize: extSize,
                    expectedSize: msg.e2eExpectedSize,
                    extractedCrc32: extCrc,
                    expectedCrc32: msg.e2eExpectedCrc,
                    crcMatch: extCrc === msg.e2eExpectedCrc && extSize === msg.e2eExpectedSize,
                    peakWorkerHeapMB: Math.round((e2ePeakHeap / (1024 * 1024)) * 100) / 100
                };

                self.postMessage({
                    type: 'LOG',
                    text: 'Benchmark 1 Complete: ' + JSON.stringify(results.e2e)
                });

                // ------------------------------------------------------------
                // Benchmark 2: 10 GiB (10,737,418,240 bytes) Streaming Transfer + yEnc + CRC32 + OPFS
                // ------------------------------------------------------------
                self.postMessage({ type: 'LOG', text: 'Starting Benchmark 2: 10 GiB (10,737,418,240 bytes) transfer + yEnc decode + CRC32 + OPFS write...' });
                const t010g = performance.now();
                let peakHeap10g = 0;
                let lastLoggedPct = -1;

                const ws10g = await self.SpotwebStorageManager.openOpfsJobWorkspace('bench_10gb');
                const runner10g = new self.SpotwebDownloadWorker.DownloadJobRunner({
                    jobId: 'bench_10gb',
                    nzbXml: msg.tenGbNzbXml,
                    relayConfig: {
                        mode: 'http',
                        httpBatchUrl: location.origin + '/api/nntp-batch',
                        maxConnections: 6,
                        batchSize: 4
                    },
                    workspace: ws10g,
                    skipExportToDir: true,
                    keepWorkspaceOnComplete: true,
                    onUpdate: (snap) => {
                        if (snap.peakMemoryBytes > peakHeap10g) {
                            peakHeap10g = snap.peakMemoryBytes;
                        }
                        const bucket = Math.floor(snap.progressPct / 10) * 10;
                        if (bucket > lastLoggedPct && bucket <= 100) {
                            lastLoggedPct = bucket;
                            const mbps = Math.round((snap.speedBps / (1024 * 1024)) * 10) / 10;
                            const heapMb = Math.round((snap.peakMemoryBytes / (1024 * 1024)) * 10) / 10;
                            self.postMessage({
                                type: 'LOG',
                                text: '  [10 GiB Progress] ' + snap.progressPct.toFixed(1) + '% (' +
                                    snap.completedSegments + '/' + snap.totalSegments + ' parts, ' +
                                    (snap.decodedBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GiB written to OPFS, ' +
                                    mbps + ' MB/s, peak heap ' + heapMb + ' MB)'
                            });
                        }
                    }
                });

                await runner10g.run();
                const elapsed10gMs = Math.round(performance.now() - t010g);

                // Inspect the 10 GiB file in OPFS before cleaning up
                const tenGbHandle = await ws10g.openSyncHandle('staging', 'benchmark-10gb.bin');
                const opfsFileSize = tenGbHandle.getSize();
                const quotaInfo = await self.SpotwebStorageManager.checkStorageQuota(0);

                // Compute combined 10 GiB CRC32 from IndexedDB segment checkpoints
                const segCheckpoints = await runner10g.checkpointStore.getJobSegments('bench_10gb');
                segCheckpoints.sort((a, b) => a.partNumber - b.partNumber);
                let combinedCrc = 0;
                for (let i = 0; i < segCheckpoints.length; i++) {
                    combinedCrc = i === 0
                        ? segCheckpoints[i].crc32
                        : self.SpotwebYencDecoder.crc32Combine(combinedCrc, segCheckpoints[i].crc32, segCheckpoints[i].size);
                }
                combinedCrc = combinedCrc >>> 0;

                // Clean up the 10 GiB OPFS file and IndexedDB checkpoints immediately
                await ws10g.destroy();
                await runner10g.checkpointStore.deleteJob('bench_10gb');

                const throughputMBps = Math.round(((opfsFileSize / (1024 * 1024)) / (elapsed10gMs / 1000)) * 100) / 100;
                results.tenGb = {
                    state: runner10g.state,
                    elapsedMs: elapsed10gMs,
                    elapsedSeconds: Math.round((elapsed10gMs / 1000) * 100) / 100,
                    totalSegments: runner10g.totalSegments,
                    completedSegments: runner10g.completedSegments,
                    downloadedWireBytes: runner10g.downloadedBytes,
                    decodedBytes: runner10g.decodedBytes,
                    opfsFileSize,
                    expectedSize: msg.tenGbExpectedSize,
                    combinedCrc32: combinedCrc,
                    expectedCrc32: msg.tenGbExpectedCrc,
                    crcMatch: combinedCrc === msg.tenGbExpectedCrc && opfsFileSize === msg.tenGbExpectedSize,
                    throughputMBps,
                    peakWorkerHeapBytes: peakHeap10g,
                    peakWorkerHeapMB: Math.round((peakHeap10g / (1024 * 1024)) * 100) / 100,
                    opfsUsageBeforeCleanupBytes: quotaInfo.usage
                };

                self.postMessage({ type: 'DONE', results });
            } catch (err) {
                self.postMessage({
                    type: 'ERROR',
                    error: (err && err.stack) ? err.stack : String(err)
                });
            }
        });
    \`;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));

    let peakMainHeap = 0;
    function sampleMainHeap() {
        if (performance && performance.memory && performance.memory.usedJSHeapSize) {
            if (performance.memory.usedJSHeapSize > peakMainHeap) {
                peakMainHeap = performance.memory.usedJSHeapSize;
            }
        }
    }

    worker.addEventListener('message', async (ev) => {
        sampleMainHeap();
        const data = ev.data || {};
        if (data.type === 'LOG') {
            await postLog(data.text);
        } else if (data.type === 'DONE') {
            sampleMainHeap();
            data.results.peakMainThreadHeapMB = Math.round((peakMainHeap / (1024 * 1024)) * 100) / 100;
            await fetch('/api/report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ok: true, results: data.results })
            });
        } else if (data.type === 'ERROR') {
            await fetch('/api/report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ok: false, error: data.error })
            });
        }
    });

    worker.postMessage({
        type: 'RUN_BENCHMARKS',
        e2eNzbXml: ${JSON.stringify(fixtures.e2eNzbXml)},
        e2eExpectedSize: ${fixtures.e2eExpectedSize},
        e2eExpectedCrc: ${fixtures.e2eExpectedCrc},
        tenGbNzbXml: ${JSON.stringify(fixtures.tenGbNzbXml)},
        tenGbExpectedSize: ${fixtures.tenGbExpectedSize},
        tenGbExpectedCrc: ${fixtures.tenGbExpectedCrc}
    });
}

runBenchmarkInWorker().catch(async (err) => {
    await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: String(err && err.stack || err) })
    });
});
</script>
</body>
</html>`;
}

// ============================================================================
// Main Runner
// ============================================================================
async function main() {
    const browserExe = findBrowserExecutable();
    console.log(`[Setup] Using browser executable: ${browserExe}`);

    const fixtures = buildFixtures();
    const htmlContent = getBenchmarkHtml(fixtures);
    const repoRoot = path.resolve(__dirname, '../..');
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-chrome-bench-'));

    let resolveDone;
    let rejectDone;
    const donePromise = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });

    const server = http.createServer((req, res) => {
        const urlObj = new URL(req.url, 'http://127.0.0.1');

        if (req.method === 'GET' && urlObj.pathname === '/benchmark.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(htmlContent);
            return;
        }

        if (req.method === 'GET' && urlObj.pathname.startsWith('/js/browser-download/')) {
            const filePath = path.join(repoRoot, urlObj.pathname);
            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            const mime = ext === '.wasm'
                ? 'application/wasm'
                : 'application/javascript; charset=utf-8';
            res.writeHead(200, { 'Content-Type': mime });
            fs.createReadStream(filePath).pipe(res);
            return;
        }

        if (req.method === 'POST' && urlObj.pathname === '/api/nntp-batch') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const ids = parsed.messageIds || [];
                    const frames = [];

                    for (let i = 0; i < ids.length; i++) {
                        const msgId = ids[i];
                        if (msgId.startsWith('10gb.p')) {
                            const partNum = parseInt(msgId.slice(6), 10);
                            const artBuf = fixtures.build10GbArticle(partNum);
                            frames.push({
                                status: 222,
                                messageId: msgId,
                                body: new Uint8Array(artBuf.buffer, artBuf.byteOffset, artBuf.byteLength)
                            });
                        } else {
                            const art = fixtures.e2eArticles.get(msgId);
                            if (!art) {
                                frames.push({ status: 430, messageId: msgId, body: new Uint8Array(0) });
                            } else {
                                frames.push({ status: art.status, messageId: msgId, body: art.body });
                                // Restore corrupted segment after first fetch only if testing transient retry?
                                // No: keep e2e.f1.p3 corrupt so PAR2 repair is exercised on BOTH missing + corrupt slices!
                            }
                        }
                    }

                    const bin = NntpClient.encodeBinaryBatchFrames(frames);
                    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                    res.end(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength));
                } catch (err) {
                    res.writeHead(500);
                    res.end(String(err));
                }
            });
            return;
        }

        if (req.method === 'POST' && urlObj.pathname === '/api/log') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                try {
                    const { msg } = JSON.parse(body);
                    console.log(`[Chrome Worker] ${msg}`);
                } catch (_) {}
                res.writeHead(200);
                res.end('ok');
            });
            return;
        }

        if (req.method === 'POST' && urlObj.pathname === '/api/report') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                res.writeHead(200);
                res.end('ok');
                try {
                    const report = JSON.parse(body);
                    if (report.ok) {
                        resolveDone(report.results);
                    } else {
                        rejectDone(new Error(report.error || 'Benchmark failed in Chrome'));
                    }
                } catch (e) {
                    rejectDone(e);
                }
            });
            return;
        }

        res.writeHead(404);
        res.end('Not found');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const benchUrl = `http://127.0.0.1:${port}/benchmark.html`;
    console.log(`[Setup] Local NNTP & Static Benchmark Server listening on ${benchUrl}`);

    const chromeProc = spawn(browserExe, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--enable-precise-memory-info',
        '--js-flags=--expose-gc',
        `--user-data-dir=${userDataDir}`,
        benchUrl
    ], { stdio: 'ignore' });

    try {
        const results = await donePromise;
        console.log('\n================================================================');
        console.log('CHROME BROWSER FEASIBILITY & BENCHMARK RESULTS');
        console.log('================================================================');
        console.log(JSON.stringify(results, null, 2));

        if (!results.e2e || !results.e2e.crcMatch) {
            throw new Error('E2E RAR5 + PAR2 repair CRC verification failed in Chrome!');
        }
        if (!results.tenGb || !results.tenGb.crcMatch) {
            throw new Error('10 GiB transfer CRC or size verification failed in Chrome!');
        }

        const outPath = path.join(repoRoot, 'tests', 'js', 'chrome-benchmark-results.json');
        fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
        console.log(`\nSaved benchmark metrics to ${outPath}`);
    } finally {
        try { chromeProc.kill('SIGKILL'); } catch (_) {}
        server.close();
        // Wait briefly for Chrome file locks to release before deleting temp user-data-dir
        await new Promise((r) => setTimeout(r, 1000));
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch (_) {}
    }
}

main().catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
});
