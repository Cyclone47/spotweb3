/**
 * Spotweb Browser Download Engine - Dedicated Web Worker & Pipeline Runner
 *
 * Orchestrates the complete download lifecycle off the main browser UI thread:
 *   Phase 1: Streaming NNTP download + zero-copy yEnc decode + IEEE CRC32 check -> OPFS staging
 *   Phase 2: PAR2 verification + on-demand .volXX+YY.par2 download + striped GF(2^16) RS repair
 *   Phase 3: Disk-backed multi-volume archive extraction (RAR4, RAR5, 7z, ZIP) via 7z-wasm + SyncHandleFS
 *   Phase 4: Export verified/extracted files to user's local directory handle + OPFS cleanup
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(
            require('./nzb-parser.js'),
            require('./yenc-decoder.js'),
            require('./par2-engine.js'),
            require('./archive-extractor.js'),
            require('./nntp-client.js'),
            require('./storage-manager.js')
        );
    } else {
        // In a Dedicated Web Worker, load sibling scripts if not already loaded
        if (typeof importScripts === 'function' && !root.SpotwebNzbParser) {
            const base = (self.location && self.location.href)
                ? self.location.href.substring(0, self.location.href.lastIndexOf('/') + 1)
                : 'js/browser-download/';
            const imports = [
                base + 'nzb-parser.js',
                base + 'yenc-decoder.js',
                base + 'par2-engine.js',
                base + 'archive-extractor.js',
                base + 'nntp-client.js',
                base + 'storage-manager.js',
                base + 'vendor/7zz.umd.js'
            ];
            importScripts.apply(null, imports.map(url => url + self.location.search));
        }
        root.SpotwebDownloadWorker = factory(
            root.SpotwebNzbParser,
            root.SpotwebYencDecoder,
            root.SpotwebPar2Engine,
            root.SpotwebArchiveExtractor,
            root.SpotwebNntpClient,
            root.SpotwebStorageManager
        );
    }
}(typeof self !== 'undefined' ? self : this, function (
    NzbParser,
    YencDecoder,
    Par2Engine,
    ArchiveExtractor,
    NntpClient,
    StorageManager
) {
    'use strict';

    /**
     * Reads an entire SyncHandle into a `Uint8Array` (used only for `.par2` packet files).
     */
    function readAllFromSyncHandle(syncHandle) {
        const size = syncHandle.getSize();
        const buf = new Uint8Array(size);
        if (size > 0) {
            syncHandle.read(buf, { at: 0 });
        }
        return buf;
    }

    /**
     * Builds a synchronous `fileProvider` adapter over pre-opened staging `SyncHandle`s
     * for `Par2Engine.verifyFiles` and `Par2Engine.repairFiles`.
     */
    function createPar2FileProvider(handleMap, renamesOut) {
        return {
            exists(filename) {
                return handleMap.has(filename);
            },
            getSize(filename) {
                const h = handleMap.get(filename);
                return h ? h.getSize() : 0;
            },
            read(filename, uint8View, offset) {
                const h = handleMap.get(filename);
                if (!h) return 0;
                return h.read(uint8View, { at: offset });
            },
            write(filename, uint8View, offset) {
                const h = handleMap.get(filename);
                if (!h) {
                    throw new Error(`Missing staging handle for PAR2 write target: ${filename}`);
                }
                return h.write(uint8View, { at: offset });
            },
            truncate(filename, size) {
                const h = handleMap.get(filename);
                if (h && typeof h.truncate === 'function') {
                    h.truncate(size);
                }
            },
            listFiles() {
                return Array.from(handleMap.keys());
            },
            rename(oldName, newName) {
                const h = handleMap.get(oldName);
                if (h) {
                    handleMap.delete(oldName);
                    handleMap.set(newName, h);
                    if (Array.isArray(renamesOut)) {
                        renamesOut.push({ oldName, newName });
                    }
                }
            }
        };
    }

    /**
     * Stateful pipeline runner for a single browser download job.
     */
    class DownloadJobRunner {
        /**
         * @param {Object} options
         * @param {string} options.jobId
         * @param {string} [options.spotTitle]
         * @param {string} [options.nzbXml]
         * @param {Object} [options.parsedNzb]
         * @param {string} [options.password]
         * @param {Object} options.relayConfig - { mode, wsUrl, httpBatchUrl, token, maxConnections, batchSize }
         * @param {FileSystemDirectoryHandle} [options.dirHandle]
         * @param {Object} [options.workspace] - Custom OpfsJobWorkspace (or test workspace)
         * @param {Object} [options.checkpointStore] - Custom CheckpointStore
         * @param {Function} [options.sevenZipFactory] - 7z-wasm factory function
         * @param {ArrayBuffer|Uint8Array} [options.wasmBinary] - Preloaded 7zz.wasm binary
         * @param {string} [options.wasmUrl] - URL to 7zz.wasm
         * @param {boolean} [options.skipExportToDir=false] - Keep files in workspace without exporting to dirHandle
         * @param {boolean} [options.keepWorkspaceOnComplete=false] - Preserve workspace after completion
         * @param {function(Object): void} [options.onUpdate] - State/progress callback
         */
        constructor(options) {
            this.jobId = String(options.jobId);
            this.spotTitle = options.spotTitle || '';
            this.nzbXml = options.nzbXml || '';
            this.parsedNzb = options.parsedNzb || null;
            this.password = options.password || '';
            this.relayConfig = options.relayConfig || {};
            this.dirHandle = options.dirHandle || null;
            this.workspace = options.workspace || null;
            this.checkpointStore = options.checkpointStore || new StorageManager.CheckpointStore();
            this.sevenZipFactory = options.sevenZipFactory || (typeof self !== 'undefined' && self.SevenZip ? self.SevenZip : null);
            this.wasmBinary = options.wasmBinary || null;
            this.wasmUrl = options.wasmUrl || (typeof self !== 'undefined' && self.location
                ? self.location.href.substring(0, self.location.href.lastIndexOf('/') + 1) + 'vendor/7zz.wasm'
                : null);
            this.skipExportToDir = Boolean(options.skipExportToDir);
            this.keepWorkspaceOnComplete = Boolean(options.keepWorkspaceOnComplete);
            this.onUpdate = options.onUpdate || (() => {});

            this.state = 'queued';
            this.phaseDetail = 'Queued';
            this.paused = false;
            this.abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
            this.nntpPool = null;

            // Metrics
            this.startTimeMs = 0;
            this.downloadedBytes = 0;
            this.decodedBytes = 0;
            this.totalEstimatedBytes = 0;
            this.completedSegments = 0;
            this.totalSegments = 0;
            this.missingSegments = 0;
            this.corruptSegments = 0;
            this.repairedSlices = 0;
            this.extractedFiles = [];
            this.outputFiles = [];
            this.errorCode = null;
            this.errorMessage = null;
            this.peakMemoryBytes = 0;
            this._lastProgressEmit = 0;
            this._speedSamples = [];
            this._downloadComplete = false;
        }

        _sampleMemory() {
            let mem = 0;
            if (typeof performance !== 'undefined' && performance.memory && performance.memory.usedJSHeapSize) {
                mem = performance.memory.usedJSHeapSize;
            } else if (typeof process !== 'undefined' && typeof process.memoryUsage === 'function') {
                mem = process.memoryUsage().heapUsed;
            }
            if (mem > this.peakMemoryBytes) {
                this.peakMemoryBytes = mem;
            }
            return mem;
        }

        _emitStatus(force = false, extra = {}) {
            const now = Date.now();
            if (!force && now - this._lastProgressEmit < 150) {
                return;
            }
            this._lastProgressEmit = now;
            this._sampleMemory();

            this._speedSamples.push({ time: now, bytes: this.downloadedBytes });
            while (this._speedSamples.length > 2 && this._speedSamples[1].time <= now - 5000) {
                this._speedSamples.shift();
            }
            const firstSample = this._speedSamples[0];
            const elapsedSec = (now - firstSample.time) / 1000;
            const speedBps = !this.paused && this.state === 'downloading' && elapsedSec > 0
                ? Math.round(Math.max(0, this.downloadedBytes - firstSample.bytes) / elapsedSec) : 0;
            const remainingBytes = Math.max(0, this.totalEstimatedBytes - this.downloadedBytes);
            const etaSeconds = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : null;
            const progressPct = this.totalSegments > 0
                ? Math.min(100, Math.round((this.completedSegments / this.totalSegments) * 1000) / 10)
                : 0;

            const snapshot = Object.assign({
                jobId: this.jobId,
                spotTitle: this.spotTitle,
                state: this.state,
                phaseDetail: this.phaseDetail,
                paused: this.paused,
                progressPct,
                downloadedBytes: this.downloadedBytes,
                decodedBytes: this.decodedBytes,
                totalBytes: this.totalEstimatedBytes,
                completedSegments: this.completedSegments,
                totalSegments: this.totalSegments,
                missingSegments: this.missingSegments,
                corruptSegments: this.corruptSegments,
                repairedSlices: this.repairedSlices,
                speedBps,
                relayDiagnostics: this.nntpPool ? this.nntpPool.getDiagnostics() : null,
                etaSeconds,
                peakMemoryBytes: this.peakMemoryBytes,
                outputFiles: this.outputFiles,
                errorCode: this.errorCode,
                errorMessage: this.errorMessage,
                updatedAt: now
            }, extra);

            this.onUpdate(snapshot);
        }

        pause() {
            this.paused = true;
            this._emitStatus(true);
        }

        resume() {
            this.paused = false;
            this._speedSamples = [];
            this._emitStatus(true);
        }

        cancel() {
            this.state = 'cancelled';
            this.phaseDetail = 'Cancelled by user';
            if (this.abortController) {
                this.abortController.abort();
            }
            if (this.nntpPool) {
                this.nntpPool.close();
            }
            if (this.workspace) {
                try { this.workspace.closeAllHandles(); } catch (_) {}
            }
            this._emitStatus(true);
        }

        /**
         * Downloads a list of NZB file entries into the workspace's `staging` area.
         *
         * @param {Array<Object>} filesToDownload
         * @param {Set<string>} completedSegKeys - Set of `${fileIndex}:${partNumber}` already on disk
         */
        async _downloadNzbFiles(filesToDownload, completedSegKeys) {
            const segmentTasks = [];

            for (let i = 0; i < filesToDownload.length; i++) {
                const file = filesToDownload[i];
                let fallbackOffset = 0;
                for (let j = 0; j < file.segments.length; j++) {
                    const seg = file.segments[j];
                    const segKey = `${file.index}:${seg.number}`;
                    if (completedSegKeys.has(segKey)) {
                        fallbackOffset += seg.bytes;
                        continue;
                    }
                    segmentTasks.push({
                        fileIndex: file.index,
                        filename: file.filename,
                        partNumber: seg.number,
                        expectedBytes: seg.bytes,
                        messageId: seg.messageId,
                        fallbackOffset
                    });
                    fallbackOffset += seg.bytes;
                }
            }

            if (segmentTasks.length === 0) {
                return;
            }

            if (!this.nntpPool) {
                this.nntpPool = new NntpClient.NntpClientPool(this.relayConfig);
            }

            const pendingCheckpoints = [];
            const flushCheckpoints = async () => {
                if (pendingCheckpoints.length === 0) return;
                const batch = pendingCheckpoints.splice(0, pendingCheckpoints.length);
                await this.checkpointStore.saveSegmentCheckpointsBatch(batch);
            };

            try {
                await this.nntpPool.downloadSegments(
                    segmentTasks,
                    async (task, frame) => {
                        if (this.state === 'cancelled') {
                            throw new NntpClient.NntpError('ABORTED', 'Download cancelled', false);
                        }

                        // Check if article was missing on the NNTP server (430 / 423)
                        if (frame.status !== 222 && frame.status !== 220) {
                            this.missingSegments++;
                            this.completedSegments++;
                            this._emitStatus(false);
                            return;
                        }

                        this.downloadedBytes += frame.body.byteLength;

                        // Decode yEnc payload + verify CRC32
                        let decoded = null;
                        let crcValid = true;
                        try {
                            decoded = YencDecoder.decodeYencArticle(frame.body, { strictCrc: true });
                        } catch (firstErr) {
                            // Retry once on transient wire corruption
                            try {
                                const retryFrames = await this.nntpPool.fetchBatchWithRetry(
                                    0,
                                    [task.messageId],
                                    this.abortController ? this.abortController.signal : undefined
                                );
                                if (retryFrames && retryFrames[0] && retryFrames[0].status === 222) {
                                    decoded = YencDecoder.decodeYencArticle(retryFrames[0].body, { strictCrc: true });
                                }
                            } catch (_) {}

                            if (!decoded) {
                                crcValid = false;
                                this.corruptSegments++;
                                // Attempt non-strict decode so intact bytes in the slice still land on disk
                                try {
                                    decoded = YencDecoder.decodeYencArticle(frame.body, { strictCrc: false });
                                } catch (_) {
                                    this.completedSegments++;
                                    this._emitStatus(false);
                                    return;
                                }
                            }
                        }

                        const writeOffset = decoded.offset !== undefined && decoded.offset >= 0
                            ? decoded.offset
                            : task.fallbackOffset;

                        const syncHandle = await this.workspace.openSyncHandle('staging', task.filename);
                        syncHandle.write(decoded.data, { at: writeOffset });

                        this.decodedBytes += decoded.data.byteLength;
                        this.completedSegments++;

                        if (crcValid) {
                            pendingCheckpoints.push({
                                jobId: this.jobId,
                                fileIndex: task.fileIndex,
                                partNumber: task.partNumber,
                                begin: writeOffset + 1,
                                end: writeOffset + decoded.data.byteLength,
                                size: decoded.data.byteLength,
                                crc32: decoded.crc32
                            });
                            if (pendingCheckpoints.length >= 64) {
                                await flushCheckpoints();
                            }
                        }

                        this._emitStatus(false);
                    },
                    {
                        signal: this.abortController ? this.abortController.signal : undefined,
                        isPaused: () => this.paused
                    }
                );
            } finally {
                await flushCheckpoints();
                // Flush all open staging handles after batch completes
                for (const h of this.workspace.openHandles.values()) {
                    try { h.flush(); } catch (_) {}
                }
            }
        }

        /**
         * Runs the full download, verification, repair, extraction, and export pipeline.
         */
        async run() {
            try {
                if (!this.startTimeMs) {
                    this.startTimeMs = Date.now();
                }

                if (!this.workspace) {
                    this.workspace = await StorageManager.openOpfsJobWorkspace(this.jobId);
                }

                // If download & PAR2 repair already completed and we're resuming after password or folder permission prompt,
                // jump straight to Phase 3 & 4!
                if (this._downloadComplete) {
                    await this._runExtractionAndExport();
                    return;
                }

                // 1. Parse NZB if not already parsed
                if (!this.parsedNzb) {
                    this.parsedNzb = NzbParser.parseNzb(this.nzbXml);
                }
                const meta = this.parsedNzb.meta || {};
                if (!this.spotTitle) {
                    this.spotTitle = meta.title || 'Spotweb Download';
                }
                if (!this.password && meta.password) {
                    this.password = meta.password;
                }

                // Partition files into initial files vs on-demand PAR2 volume files
                const initialFiles = [];
                const par2VolumeFiles = [];
                const par2IndexFiles = [];

                for (let i = 0; i < this.parsedNzb.files.length; i++) {
                    const f = this.parsedNzb.files[i];
                    const role = f.role || f.category;
                    if (role === 'par2-volume') {
                        par2VolumeFiles.push(f);
                    } else {
                        initialFiles.push(f);
                        if (role === 'par2-index') {
                            par2IndexFiles.push(f);
                        }
                    }
                }

                // Sort PAR2 recovery volumes by recovery block count ascending
                par2VolumeFiles.sort((a, b) => (a.par2BlockCount || 0) - (b.par2BlockCount || 0));

                // Calculate initial totals
                this.totalEstimatedBytes = initialFiles.reduce((acc, f) => acc + (f.estimatedBytes || f.totalBytes || 0), 0);
                this.totalSegments = initialFiles.reduce((acc, f) => acc + f.segments.length, 0);

                // Check storage quota: archives need staging + extraction space (~1.8x), direct files need 1x
                const hasArchiveFiles = initialFiles.some((f) => (f.role || f.category) === 'archive');
                const requiredQuotaBytes = hasArchiveFiles
                    ? Math.round(this.totalEstimatedBytes * 1.8)
                    : Math.round(this.totalEstimatedBytes * 0.98);
                const quotaCheck = await StorageManager.checkStorageQuota(requiredQuotaBytes);
                if (!quotaCheck.ok) {
                    const availMb = Math.round(quotaCheck.available / (1024 * 1024));
                    const reqMb = Math.round(requiredQuotaBytes / (1024 * 1024));
                    const err = new Error(`Insufficient browser storage quota (${availMb} MB available, ~${reqMb} MB required)`);
                    err.code = 'QUOTA_EXCEEDED';
                    throw err;
                }

                // Load existing segment checkpoints for resume support
                const savedCheckpoints = await this.checkpointStore.getJobSegments(this.jobId);
                const completedSegKeys = new Set();
                this.completedSegments = 0;
                this.downloadedBytes = 0;
                this.decodedBytes = 0;

                for (let i = 0; i < savedCheckpoints.length; i++) {
                    const cp = savedCheckpoints[i];
                    completedSegKeys.add(`${cp.fileIndex}:${cp.partNumber}`);
                    this.completedSegments++;
                    this.downloadedBytes += cp.size || 0;
                    this.decodedBytes += cp.size || 0;
                }

                // =========================================================================
                // PHASE 1: DOWNLOAD & YENC DECODE
                // =========================================================================
                this.restoredBytes = this.downloadedBytes;
                this._speedSamples = [];
                this.startTimeMs = Date.now();
                this.state = 'downloading';
                this.phaseDetail = 'Downloading articles & decoding yEnc...';
                this._emitStatus(true);

                await this._downloadNzbFiles(initialFiles, completedSegKeys);

                if (this.nntpPool) {
                    this.nntpPool.close();
                    this.nntpPool = null;
                }

                // =========================================================================
                // PHASE 2: PAR2 VERIFICATION & SMART ON-DEMAND REPAIR
                // =========================================================================
                const hasDamage = this.missingSegments > 0 || this.corruptSegments > 0;
                const hasPar2 = par2IndexFiles.length > 0 || par2VolumeFiles.length > 0;

                if (hasPar2) {
                    this.state = 'verifying';
                    this.phaseDetail = 'Verifying file integrity with PAR2...';
                    this._emitStatus(true);

                    const parsedSets = [];

                    // If there were no `.par2` index files but `.vol*.par2` exists, grab the smallest volume first
                    if (par2IndexFiles.length === 0 && par2VolumeFiles.length > 0) {
                        const firstVol = par2VolumeFiles.shift();
                        this.totalEstimatedBytes += (firstVol.estimatedBytes || 0);
                        this.totalSegments += firstVol.segments.length;
                        await this._downloadNzbFiles([firstVol], completedSegKeys);
                        par2IndexFiles.push(firstVol);
                    }

                    for (let i = 0; i < par2IndexFiles.length; i++) {
                        const pf = par2IndexFiles[i];
                        const h = await this.workspace.openSyncHandle('staging', pf.filename);
                        const bytes = readAllFromSyncHandle(h);
                        if (bytes.byteLength > 0) {
                            parsedSets.push(Par2Engine.parsePar2Packets(bytes, { sourceFilename: pf.filename }));
                        }
                    }

                    let par2Set = parsedSets.length > 0 ? Par2Engine.mergePar2Sets(parsedSets) : null;

                    if (par2Set && par2Set.recoveryFileIds.length > 0) {
                        const openStagingMap = async () => {
                            const map = new Map();
                            const entries = await this.workspace.listFiles('staging');
                            for (let i = 0; i < entries.length; i++) {
                                const name = entries[i].name;
                                const h = await this.workspace.openSyncHandle('staging', name);
                                map.set(name, h);
                            }
                            return map;
                        };

                        let stagingMap = await openStagingMap();
                        const pendingRenames = [];
                        let fileProvider = createPar2FileProvider(stagingMap, pendingRenames);

                        const verifyRes = Par2Engine.verifyFiles(par2Set, fileProvider, (prog) => {
                            this.phaseDetail = `Verifying files (${prog.completedFiles}/${prog.totalFiles})...`;
                            this._emitStatus(false);
                        });

                        // Apply any de-obfuscation renames discovered via 16KB MD5 matching in OPFS
                        for (let r = 0; r < pendingRenames.length; r++) {
                            const ren = pendingRenames[r];
                            await this.workspace.renameStagingFile(ren.oldName, ren.newName);
                        }

                        if (!verifyRes.allValid) {
                            const neededBlocks = verifyRes.damagedSliceCount;
                            this.state = 'repairing';
                            this.phaseDetail = `Repair required (${neededBlocks} damaged/missing slice(s)). Fetching PAR2 recovery volumes...`;
                            this._emitStatus(true);

                            const volsToFetch = [];
                            let gatheredBlocks = verifyRes.availableRecoveryCount;

                            for (let i = 0; i < par2VolumeFiles.length && gatheredBlocks < neededBlocks; i++) {
                                const vf = par2VolumeFiles[i];
                                volsToFetch.push(vf);
                                gatheredBlocks += (vf.par2BlockCount || 1);
                            }

                            if (volsToFetch.length > 0) {
                                for (let i = 0; i < volsToFetch.length; i++) {
                                    this.totalEstimatedBytes += (volsToFetch[i].estimatedBytes || 0);
                                    this.totalSegments += volsToFetch[i].segments.length;
                                }
                                this.nntpPool = new NntpClient.NntpClientPool(this.relayConfig);
                                await this._downloadNzbFiles(volsToFetch, completedSegKeys);
                                this.nntpPool.close();
                                this.nntpPool = null;

                                for (let i = 0; i < volsToFetch.length; i++) {
                                    const vf = volsToFetch[i];
                                    const h = await this.workspace.openSyncHandle('staging', vf.filename);
                                    const bytes = readAllFromSyncHandle(h);
                                    if (bytes.byteLength > 0) {
                                        parsedSets.push(Par2Engine.parsePar2Packets(bytes, { sourceFilename: vf.filename }));
                                    }
                                }
                                par2Set = Par2Engine.mergePar2Sets(parsedSets);
                            }

                            // Refresh staging map and ensure handles exist for any completely missing recovery target files
                            stagingMap = await openStagingMap();
                            for (let f = 0; f < par2Set.recoveryFileIds.length; f++) {
                                const fid = par2Set.recoveryFileIds[f];
                                const desc = par2Set.fileDescriptions[fid];
                                if (desc && !stagingMap.has(desc.filename)) {
                                    const h = await this.workspace.openSyncHandle('staging', desc.filename);
                                    stagingMap.set(desc.filename, h);
                                }
                            }

                            fileProvider = createPar2FileProvider(stagingMap, []);

                            this.phaseDetail = `Repairing ${neededBlocks} slice(s) using Reed-Solomon GF(2^16)...`;
                            this._emitStatus(true);

                            const repairRes = Par2Engine.repairFiles(par2Set, null, fileProvider, {
                                onProgress: (prog) => {
                                    if (prog.phase === 'repairing') {
                                        const pct = Math.round((prog.completedStripes / prog.totalStripes) * 100);
                                        this.phaseDetail = `Repairing ${prog.repairedSlices} slice(s) (${pct}%)...`;
                                        this._emitStatus(false);
                                    }
                                }
                            });

                            this.repairedSlices = repairRes.repairedSliceCount || 0;
                        }
                    }
                } else if (hasDamage) {
                    const err = new Error(
                        `Download incomplete: ${this.missingSegments} missing and ${this.corruptSegments} corrupt segment(s), and no PAR2 recovery files are available.`
                    );
                    err.code = 'MISSING_ARTICLES_NO_PAR2';
                    throw err;
                }

                this._downloadComplete = true;

                // =========================================================================
                // PHASE 3 & 4: MULTI-VOLUME ARCHIVE EXTRACTION & EXPORT
                // =========================================================================
                await this._runExtractionAndExport();

            } catch (err) {
                if (this.nntpPool) {
                    this.nntpPool.close();
                    this.nntpPool = null;
                }
                if (this.state === 'cancelled' || err.code === 'ABORTED') {
                    this.state = 'cancelled';
                    this.phaseDetail = 'Cancelled';
                    this._emitStatus(true);
                    return;
                }
                if (err.code === 'PASSWORD_REQUIRED' || err.code === 'WRONG_PASSWORD') {
                    this.state = 'password_required';
                    this.errorCode = err.code;
                    this.errorMessage = err.message;
                    this.phaseDetail = err.code === 'WRONG_PASSWORD'
                        ? 'Incorrect archive password. Please enter the correct password.'
                        : 'Archive is password-protected. Please enter password to extract.';
                    this._emitStatus(true);
                    return;
                }
                if (err.code === 'PERMISSION_REQUIRED') {
                    this.state = 'permission_required';
                    this.errorCode = err.code;
                    this.errorMessage = err.message;
                    this.phaseDetail = 'Folder write permission needed to save completed files.';
                    this._emitStatus(true);
                    return;
                }

                this.state = 'failed';
                this.errorCode = err.code || 'DOWNLOAD_FAILED';
                this.errorMessage = err.message || String(err);
                this.phaseDetail = `Failed: ${this.errorMessage}`;
                this._emitStatus(true);
                throw err;
            }
        }

        /**
         * Continues from Phase 3 (Extraction) & Phase 4 (Export to user directory).
         */
        async _runExtractionAndExport() {
            const stagedEntries = await this.workspace.listFiles('staging');
            const dataEntries = stagedEntries.filter((e) => !/\.par2$/i.test(e.name));

            const inputVolumes = [];
            for (let i = 0; i < dataEntries.length; i++) {
                const name = dataEntries[i].name;
                const handle = await this.workspace.openSyncHandle('staging', name);
                if (handle.getSize() === 0) continue;
                inputVolumes.push({ name, handle });
            }

            const prepared = ArchiveExtractor.prepareArchiveVolumes(inputVolumes);
            const archiveVolumes = prepared.volumes.filter((v) => v.info.isArchive);
            const extractedItems = [];

            if (archiveVolumes.length > 0) {
                this.state = 'extracting';
                const fmtLabel = (prepared.entryVolume && prepared.entryVolume.info.format)
                    ? prepared.entryVolume.info.format.toUpperCase()
                    : 'ARCHIVE';
                this.phaseDetail = `Extracting ${fmtLabel} (${archiveVolumes.length} volume(s))...`;
                this._emitStatus(true);

                const extractResult = await ArchiveExtractor.extractArchive({
                    inputVolumes: archiveVolumes.map((v) => ({
                        name: v.originalName,
                        handle: v.handle
                    })),
                    password: this.password,
                    wasmOptions: {
                        sevenZipFactory: this.sevenZipFactory,
                        wasmBinary: this.wasmBinary,
                        wasmUrl: this.wasmUrl
                    },
                    createOutputHandle: async (safeRelPath) => {
                        const opfsKey = `out_${extractedItems.length}_${NzbParser.sanitizeFilename(safeRelPath)}`;
                        const outHandle = await this.workspace.openSyncHandle('extracted', opfsKey);
                        extractedItems.push({
                            opfsKey,
                            relativePath: safeRelPath,
                            syncHandle: outHandle
                        });
                        return outHandle;
                    },
                    onProgress: (p) => {
                        const pct = p.totalBytes > 0
                            ? Math.min(100, Math.round((p.extractedBytes / p.totalBytes) * 100))
                            : 0;
                        this.phaseDetail = `Extracting ${p.currentFile || ''} (${pct}%)...`;
                        this._emitStatus(false);
                    }
                });

                this.extractedFiles = extractResult.extractedFiles || [];
            }

            // =========================================================================
            // PHASE 4: EXPORT TO USER DIRECTORY & CLEANUP
            // =========================================================================
            if (!this.skipExportToDir && this.dirHandle) {
                const perm = await StorageManager.verifyDirectoryPermission(this.dirHandle, false);
                if (perm !== 'granted') {
                    const permErr = new Error('Write permission to destination folder is required.');
                    permErr.code = 'PERMISSION_REQUIRED';
                    throw permErr;
                }

                this.state = 'finalizing';
                this.phaseDetail = 'Saving completed files to destination folder...';
                this._emitStatus(true);

                // Close all sync handles before reading via FileSystemFileHandle.getFile()
                this.workspace.closeAllHandles();

                this.outputFiles = [];
                if (extractedItems.length > 0) {
                    const extractedFileEntries = await this.workspace.listFiles('extracted');
                    const handleByName = new Map(extractedFileEntries.map((e) => [e.name, e.handle]));

                    for (let i = 0; i < extractedItems.length; i++) {
                        const item = extractedItems[i];
                        const fh = handleByName.get(item.opfsKey) ||
                            await this.workspace.extractedDirHandle.getFileHandle(item.opfsKey, { create: false });
                        const res = await StorageManager.exportOpfsFileToUserDirectory(
                            this.dirHandle,
                            item.relativePath,
                            fh
                        );
                        this.outputFiles.push({
                            path: res.finalPath,
                            size: res.bytesWritten
                        });
                    }
                } else {
                    // Direct non-archive download: export all non-PAR2 files from staging
                    const freshStaged = await this.workspace.listFiles('staging');
                    for (let i = 0; i < freshStaged.length; i++) {
                        const entry = freshStaged[i];
                        if (/\.par2$/i.test(entry.name)) continue;
                        const res = await StorageManager.exportOpfsFileToUserDirectory(
                            this.dirHandle,
                            entry.name,
                            entry.handle
                        );
                        this.outputFiles.push({
                            path: res.finalPath,
                            size: res.bytesWritten
                        });
                    }
                }
            } else {
                // OPFS-only / test workspace mode
                this.workspace.closeAllHandles();
                if (this.extractedFiles.length > 0) {
                    this.outputFiles = this.extractedFiles.slice();
                } else {
                    this.outputFiles = dataEntries.map((e) => ({ path: e.name }));
                }
            }

            if (!this.keepWorkspaceOnComplete) {
                await StorageManager.cleanupOpfsJobWorkspace(this.jobId);
                await this.checkpointStore.deleteJobSegments(this.jobId);
            }

            this.state = 'completed';
            this.errorCode = null;
            this.errorMessage = null;
            this.phaseDetail = 'Completed';
            this._emitStatus(true);
        }
    }

    // =========================================================================
    // Dedicated Web Worker Message Dispatcher
    // =========================================================================
    const activeRunners = new Map();

    if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
        self.onmessage = async function (event) {
            const msg = event.data;
            if (!msg || !msg.type) return;

            const jobId = msg.jobId ? String(msg.jobId) : '';

            switch (msg.type) {
                case 'START_JOB': {
                    let runner = activeRunners.get(jobId);
                    if (runner) {
                        runner.cancel();
                        // Let the old run flush checkpoints and release disk handles before
                        // opening the same workspace again on Retry/Resume.
                        if (runner.executionPromise) {
                            try { await runner.executionPromise; } catch (_) {}
                        }
                    }
                    runner = new DownloadJobRunner({
                        jobId,
                        spotTitle: msg.spotTitle,
                        nzbXml: msg.nzbXml,
                        parsedNzb: msg.parsedNzb,
                        password: msg.password,
                        relayConfig: msg.relayConfig,
                        dirHandle: msg.dirHandle,
                        wasmUrl: msg.wasmUrl,
                        skipExportToDir: msg.skipExportToDir,
                        keepWorkspaceOnComplete: msg.keepWorkspaceOnComplete,
                        onUpdate: (snapshot) => {
                            self.postMessage({
                                type: 'JOB_UPDATE',
                                jobId,
                                snapshot
                            });
                        }
                    });
                    activeRunners.set(jobId, runner);
                    try {
                        runner.executionPromise = runner.run();
                        await runner.executionPromise;
                    } catch (_) {
                        // Error state already emitted via JOB_UPDATE
                    }
                    break;
                }

                case 'PAUSE_JOB': {
                    const r = activeRunners.get(jobId);
                    if (r) r.pause();
                    break;
                }

                case 'RESUME_JOB': {
                    const r = activeRunners.get(jobId);
                    if (r) {
                        if (msg.password !== undefined) {
                            r.password = msg.password;
                        }
                        if (msg.dirHandle) {
                            r.dirHandle = msg.dirHandle;
                        }
                        r.resume();
                        if (r.state === 'password_required' || r.state === 'permission_required' || r.state === 'failed') {
                            try {
                                await r.run();
                            } catch (_) {}
                        }
                    }
                    break;
                }

                case 'CANCEL_JOB': {
                    const r = activeRunners.get(jobId);
                    if (r) {
                        r.cancel();
                        activeRunners.delete(jobId);
                    }
                    await StorageManager.cleanupOpfsJobWorkspace(jobId);
                    break;
                }
            }
        };
    }

    return {
        DownloadJobRunner,
        createPar2FileProvider
    };
}));
