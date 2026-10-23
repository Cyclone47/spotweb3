/**
 * Spotweb Browser Download Engine - Main-Thread Controller & UI Manager
 *
 * Provides:
 * - `SpotwebBrowserDownloadManager`: Singleton managing the Web Worker, IndexedDB
 *   job persistence & reload recovery, `showDirectoryPicker` folder selection,
 *   spot descriptor fetching (`?page=nntprelay&action=descriptor`), and live UI rendering.
 * - Global helper `spotwebDownloadInBrowser(messageId, spotTitle, buttonEl)` for
 *   one-click invocation from spot tables, spot info modals, and multi-NZB buttons.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(
            require('./nzb-parser.js'),
            require('./storage-manager.js')
        );
    } else {
        root.SpotwebDownloadManager = factory(
            root.SpotwebNzbParser,
            root.SpotwebStorageManager
        );
    }
}(typeof self !== 'undefined' ? self : this, function (NzbParser, StorageManager) {
    'use strict';

    function formatBytes(bytes) {
        const b = Number(bytes) || 0;
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
        return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function formatEta(seconds) {
        if (seconds === null || seconds === undefined || !isFinite(seconds) || seconds < 0) {
            return '--:--';
        }
        const s = Math.round(seconds);
        const hrs = Math.floor(s / 3600);
        const mins = Math.floor((s % 3600) / 60);
        const secs = s % 60;
        if (hrs > 0) {
            return `${hrs}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
        }
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    const STATE_LABELS = {
        queued: 'Queued',
        downloading: 'Downloading',
        verifying: 'Verifying PAR2',
        repairing: 'Repairing PAR2',
        extracting: 'Extracting Archive',
        finalizing: 'Saving to Folder',
        password_required: 'Password Required',
        permission_required: 'Folder Access Needed',
        completed: 'Completed',
        failed: 'Failed',
        cancelled: 'Cancelled'
    };

    class BrowserDownloadManager {
        constructor(options = {}) {
            const script = typeof document !== 'undefined' && document.querySelector
                ? document.querySelector('script[src*="browser-download/download-manager.js"]') : null;
            const version = script ? new URL(script.src).search : '';
            this.workerUrl = options.workerUrl || 'js/browser-download/download-worker.js' + version;
            this.descriptorUrl = options.descriptorUrl || '?page=nntprelay&action=descriptor';
            this.checkpointStore = options.checkpointStore || (StorageManager ? new StorageManager.CheckpointStore() : null);
            this.worker = null;
            this.jobs = new Map(); // jobId -> job record
            this.listeners = new Set();
            this.initialized = false;
            this.panelOpen = false;
            this.destinationDirectory = null;
        }

        /**
         * Checks whether the browser supports the required APIs (`showDirectoryPicker`, OPFS, Web Worker, WASM).
         */
        checkBrowserSupport() {
            const missing = [];
            if (typeof window !== 'undefined' && !window.isSecureContext) {
                missing.push('Secure Context (HTTPS or localhost)');
            }
            if (typeof window !== 'undefined' && typeof window.showDirectoryPicker !== 'function') {
                missing.push('File System Access API (showDirectoryPicker - requires desktop Chrome or Edge)');
            }
            if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
                missing.push('Origin Private File System (navigator.storage.getDirectory)');
            }
            if (typeof Worker === 'undefined') {
                missing.push('Web Workers');
            }
            if (typeof WebAssembly === 'undefined') {
                missing.push('WebAssembly');
            }
            return {
                supported: missing.length === 0,
                missing
            };
        }

        init() {
            if (!this.initPromise) this.initPromise = this._initialize();
            return this.initPromise;
        }

        async _initialize() {
            this.initialized = true;

            this._ensureStylesAndDom();
            this._setupUnloadWarning();

            if (this.checkpointStore) {
                try {
                    const savedJobs = await this.checkpointStore.listJobs();
                    for (let i = 0; i < savedJobs.length; i++) {
                        const job = savedJobs[i];
                        if (job.kind === 'destination') {
                            if (!this.destinationDirectory) this.destinationDirectory = job.dirHandle;
                            continue;
                        }
                        // Any job that was mid-flight when the tab closed/reloaded is placed in resumable state
                        if (
                            job.state === 'downloading' ||
                            job.state === 'verifying' ||
                            job.state === 'repairing' ||
                            job.state === 'extracting' ||
                            job.state === 'finalizing' ||
                            job.state === 'queued'
                        ) {
                            job.paused = true;
                            job.phaseDetail = 'Interrupted by page reload — click Resume to continue from checkpoint';
                        }
                        this.jobs.set(job.jobId, job);
                    }
                    this._renderUI();
                } catch (_) {}
            }
        }

        _ensureWorker() {
            if (this.worker) return this.worker;
            this.worker = new Worker(this.workerUrl);
            this.worker.onmessage = (event) => {
                const msg = event.data;
                if (!msg || msg.type !== 'JOB_UPDATE') return;
                this._handleWorkerUpdate(msg.jobId, msg.snapshot);
            };
            this.worker.onerror = (err) => {
                console.error('[SpotwebBrowserDownload] Worker error:', err);
            };
            return this.worker;
        }

        async _handleWorkerUpdate(jobId, snapshot) {
            const existing = this.jobs.get(jobId);
            if (!existing) return;
            const updated = Object.assign(existing, snapshot);
            this.jobs.set(jobId, updated);

            if (this.checkpointStore) {
                try {
                    await this.checkpointStore.saveJob(updated);
                } catch (_) {}
            }

            this._notifyListeners(updated);
            this._renderUI();
        }

        onUpdate(fn) {
            this.listeners.add(fn);
            return () => this.listeners.delete(fn);
        }

        _notifyListeners(job) {
            for (const fn of this.listeners) {
                try { fn(job, Array.from(this.jobs.values())); } catch (_) {}
            }
        }

        /**
         * Prompts the user to pick a local destination directory via `showDirectoryPicker`.
         * Must be called directly from a user gesture (click handler) so the browser allows the picker.
         */
        async pickDestinationDirectory() {
            const support = this.checkBrowserSupport();
            if (!support.supported) {
                throw new Error(
                    'Browser Download requires desktop Chrome or Edge over HTTPS/localhost. Missing: ' +
                    support.missing.join(', ')
                );
            }
            const dirHandle = await window.showDirectoryPicker({
                mode: 'readwrite'
            });
            return dirHandle;
        }

        async selectDestinationDirectory() {
            // Invoke the picker before any IndexedDB/network awaits consume user activation.
            const handle = await this.pickDestinationDirectory();
            this.destinationDirectory = handle;
            await this.init();
            if (this.checkpointStore) {
                await this.checkpointStore.saveJob({ jobId: '__destination__', kind: 'destination', dirHandle: handle });
            }
            this._renderUI();
            return handle;
        }

        requestDestinationDirectory() {
            // Native select changes do not consistently retain picker activation.
            // An explicit button in this required dialog supplies a fresh click.
            const dialog = document.createElement('dialog');
            dialog.id = 'sw-dl-folder-dialog';
            dialog.setAttribute('aria-labelledby', 'sw-dl-folder-heading');
            dialog.style.cssText = 'max-width:440px;padding:24px;border:1px solid var(--sw-border,#c9d2e3);border-radius:8px;background:var(--sw-surface,#fff);color:var(--sw-text,#1b2233);font:inherit';
            dialog.innerHTML = '<h2 id="sw-dl-folder-heading" style="font-size:18px;margin-top:0">Choose your download folder</h2>' +
                '<p>Browser downloads need a local folder to save your files. Choose a location to enable this download mode.</p>' +
                '<button type="button" class="sw-dl-btn-sm sw-dl-btn-primary" data-choose>Choose folder</button> ' +
                '<button type="button" class="sw-dl-btn-sm" data-cancel>Cancel</button>';
            document.body.appendChild(dialog);
            return new Promise((resolve, reject) => {
                const finish = (handle, err) => {
                    dialog.close();
                    dialog.remove();
                    if (err) reject(err); else resolve(handle);
                };
                const cancel = () => finish(null, new DOMException('Folder selection cancelled', 'AbortError'));
                dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
                dialog.querySelector('[data-cancel]').addEventListener('click', cancel);
                dialog.querySelector('[data-choose]').addEventListener('click', () => {
                    this.selectDestinationDirectory().then(handle => finish(handle), err => finish(null, err));
                });
                dialog.showModal();
            });
        }

        async _loadDescriptor(job) {
            const url = new URL(this.descriptorUrl, document.baseURI);
            if (job.messageIds.length === 1) {
                url.searchParams.set('messageid', job.messageIds[0]);
            } else {
                url.searchParams.set('messageids', JSON.stringify(job.messageIds));
            }
            const resp = await fetch(url.href, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
            let descriptor;
            try { descriptor = await resp.json(); } catch (_) {
                throw new Error('Spotweb returned an invalid download response (HTTP ' + resp.status + ').');
            }
            if (!resp.ok || !descriptor || !descriptor.ok) {
                throw new Error((descriptor && descriptor.error) || 'Could not retrieve the NZB (HTTP ' + resp.status + ').');
            }
            // Validate the contract on the main thread, before creating a worker.
            const parsed = NzbParser.parseNzb(descriptor.nzbXml);
            const relay = Object.assign({}, descriptor.relay);
            ['httpBatchUrl', 'renewUrl', 'wsUrl'].forEach((key) => {
                if (relay[key]) relay[key] = new URL(relay[key], document.baseURI).href;
            });
            Object.assign(job, {
                spotTitle: descriptor.title || job.spotTitle,
                nzbXml: descriptor.nzbXml,
                parsedNzb: parsed,
                relayConfig: relay,
                password: job.password || descriptor.password || '',
                totalBytes: parsed.totalBytes,
                totalSegments: parsed.totalSegments
            });
            if (this.checkpointStore) await this.checkpointStore.saveJob(job);
        }

        _startWorkerJob(job) {
            this._ensureWorker().postMessage({
                type: 'START_JOB', jobId: job.jobId, spotTitle: job.spotTitle,
                nzbXml: job.nzbXml, parsedNzb: job.parsedNzb, password: job.password,
                relayConfig: job.relayConfig, dirHandle: job.dirHandle,
                skipExportToDir: job.skipExportToDir
            });
        }

        /**
         * Starts a browser download for one or more Spotweb messageIds.
         *
         * @param {string|string[]} messageIds - Spot messageId(s)
         * @param {Object} [options]
         * @param {string} [options.spotTitle]
         * @param {FileSystemDirectoryHandle} [options.dirHandle] - Optional pre-selected directory handle
         * @param {string} [options.password] - Optional archive password
         */
        async startSpotDownload(messageIds, options = {}) {
            // Prompt first: initialization may wait on IndexedDB.
            let dirHandle = options.dirHandle || this.destinationDirectory || null;
            if (!dirHandle) {
                try {
                    dirHandle = await this.selectDestinationDirectory();
                } catch (err) {
                    if (err && err.name === 'AbortError') {
                        return null; // User cancelled folder picker
                    }
                    this._showNotification(err.message || 'Could not select destination folder', 'error');
                    throw err;
                }
            }

            await this.init();

            // Show the queue in the Downloads tab.
            this.openDownloadsPanel();

            const idList = Array.isArray(messageIds) ? messageIds : [messageIds];

            const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            const initialTitle = options.spotTitle || (idList.length === 1 ? `Spot ${idList[0]}` : `${idList.length} Spots`);

            const jobRecord = {
                jobId,
                messageIds: idList,
                spotTitle: initialTitle,
                state: 'queued',
                phaseDetail: 'Fetching NZB & relay credentials from Spotweb...',
                paused: false,
                progressPct: 0,
                downloadedBytes: 0,
                decodedBytes: 0,
                totalBytes: 0,
                completedSegments: 0,
                totalSegments: 0,
                missingSegments: 0,
                corruptSegments: 0,
                repairedSlices: 0,
                speedBps: 0,
                etaSeconds: null,
                outputFiles: [],
                dirHandle,
                dirName: dirHandle ? dirHandle.name : '',
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            this.jobs.set(jobId, jobRecord);
            if (this.checkpointStore) {
                try { await this.checkpointStore.saveJob(jobRecord); } catch (_) {}
            }
            this._renderUI();

            try {
                jobRecord.password = options.password || '';
                await this._loadDescriptor(jobRecord);
                this._startWorkerJob(jobRecord);

                // Mark spot link as downloaded in Spotweb UI if applicable
                idList.forEach((mid) => {
                    try {
                        document.querySelectorAll(`a[href*="${CSS.escape(mid)}"]`).forEach((el) => {
                            const row = el.closest('tr');
                            if (row) row.classList.add('SpotDownloaded');
                        });
                    } catch (_) {}
                });

                return jobId;
            } catch (err) {
                jobRecord.state = 'failed';
                jobRecord.errorCode = 'DESCRIPTOR_ERROR';
                jobRecord.errorMessage = err.message || String(err);
                jobRecord.phaseDetail = 'Failed: ' + jobRecord.errorMessage;
                if (this.checkpointStore) {
                    try { await this.checkpointStore.saveJob(jobRecord); } catch (_) {}
                }
                this._renderUI();
                throw err;
            }
        }

        /**
         * Starts a browser download directly from raw NZB XML + relayConfig (used by custom NZB import or tests).
         */
        async startDirectNzbDownload({ nzbXml, spotTitle, relayConfig, dirHandle, password, skipExportToDir }) {
            await this.init();
            const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            const parsedNzb = NzbParser.parseNzb(nzbXml);
            const meta = parsedNzb.meta || {};
            const title = spotTitle || meta.title || 'NZB Download';

            const jobRecord = {
                jobId,
                spotTitle: title,
                nzbXml,
                parsedNzb,
                password: password || meta.password || '',
                relayConfig,
                dirHandle: dirHandle || null,
                dirName: dirHandle ? dirHandle.name : 'OPFS',
                skipExportToDir: Boolean(skipExportToDir),
                state: 'queued',
                phaseDetail: 'Starting...',
                paused: false,
                progressPct: 0,
                downloadedBytes: 0,
                totalBytes: parsedNzb.totalBytes,
                completedSegments: 0,
                totalSegments: parsedNzb.totalSegments,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            this.jobs.set(jobId, jobRecord);
            if (this.checkpointStore) {
                try { await this.checkpointStore.saveJob(jobRecord); } catch (_) {}
            }
            this._renderUI();

            const worker = this._ensureWorker();
            worker.postMessage({
                type: 'START_JOB',
                jobId,
                spotTitle: jobRecord.spotTitle,
                nzbXml: jobRecord.nzbXml,
                parsedNzb: jobRecord.parsedNzb,
                password: jobRecord.password,
                relayConfig: jobRecord.relayConfig,
                dirHandle: jobRecord.dirHandle,
                skipExportToDir: jobRecord.skipExportToDir
            });

            return jobId;
        }

        pauseJob(jobId) {
            const job = this.jobs.get(jobId);
            if (!job) return;
            job.paused = true;
            this._renderUI();
            if (this.worker) {
                this.worker.postMessage({ type: 'PAUSE_JOB', jobId });
            }
        }

        async resumeJob(jobId, options = {}) {
            const job = this.jobs.get(jobId);
            if (!job) return;

            if (options.password !== undefined) {
                job.password = options.password;
            }

            // Ensure destination folder permission is granted when resuming on main thread
            if (job.dirHandle && !job.skipExportToDir) {
                const perm = await StorageManager.verifyDirectoryPermission(job.dirHandle, true);
                if (perm !== 'granted') {
                    // Offer user to re-pick folder if permission was denied
                    try {
                        job.dirHandle = await this.pickDestinationDirectory();
                        job.dirName = job.dirHandle.name;
                    } catch (_) {
                        return;
                    }
                }
            }

            try {
                if (!job.skipExportToDir && !job.dirHandle) {
                    job.dirHandle = await this.selectDestinationDirectory();
                    job.dirName = job.dirHandle.name;
                }
                if (job.messageIds && job.messageIds.length) await this._loadDescriptor(job);
                else NzbParser.parseNzb(job.nzbXml);
                job.paused = false;
                job.state = 'queued';
                job.errorMessage = null;
                job.phaseDetail = 'Resuming download...';
                this._startWorkerJob(job);
            } catch (err) {
                job.state = 'failed';
                job.errorMessage = err.message;
                job.phaseDetail = 'Failed: ' + err.message;
                if (this.checkpointStore) await this.checkpointStore.saveJob(job);
            }
            this._renderUI();
        }

        async cancelJob(jobId) {
            const job = this.jobs.get(jobId);
            // Remove first so the worker's final cancellation update cannot
            // resurrect the entry while IndexedDB deletion is pending.
            this.jobs.delete(jobId);
            if (this.worker) {
                this.worker.postMessage({ type: 'CANCEL_JOB', jobId });
            }
            if (job) {
                job.state = 'cancelled';
                job.phaseDetail = 'Cancelled by user';
            }
            if (this.checkpointStore) {
                try { await this.checkpointStore.deleteJob(jobId); } catch (_) {}
            }
            this._renderUI();
        }

        async clearCompletedJobs() {
            for (const [jobId, job] of this.jobs.entries()) {
                if (job.state === 'completed' || job.state === 'cancelled' || job.state === 'failed') {
                    this.jobs.delete(jobId);
                    if (this.checkpointStore) {
                        try { await this.checkpointStore.deleteJob(jobId); } catch (_) {}
                    }
                }
            }
            this._renderUI();
        }

        hasActiveDownloads() {
            for (const job of this.jobs.values()) {
                if (
                    !job.paused &&
                    (job.state === 'downloading' ||
                     job.state === 'verifying' ||
                     job.state === 'repairing' ||
                     job.state === 'extracting' ||
                     job.state === 'finalizing')
                ) {
                    return true;
                }
            }
            return false;
        }

        _setupUnloadWarning() {
            if (typeof window === 'undefined') return;
            window.addEventListener('beforeunload', (e) => {
                if (this.hasActiveDownloads()) {
                    e.preventDefault();
                    e.returnValue = 'Browser downloads are currently in progress. Leaving will pause them until you return.';
                    return e.returnValue;
                }
            });
        }

        openDownloadsPanel() {
            this.panelOpen = true;
            if (typeof window !== 'undefined' && document.body.classList.contains('spotinfo')) {
                if (window.jQuery && window.jQuery.address) window.jQuery.address.value('');
                if (typeof window.closeDetails === 'function') window.closeDetails(0);
            }
            this._renderUI();
        }

        closeDownloadsPanel() {
            this.panelOpen = false;
            this._renderUI();
        }

        toggleDownloadsPanel() { this.openDownloadsPanel(); }

        _showNotification(text, level = 'info') {
            this.notice = text;
            this._renderUI();
            if (typeof window !== 'undefined' && level === 'error') window.alert(text);
        }

        _ensureStylesAndDom() {
            if (typeof document === 'undefined' || !document.body) return;
            if (!document.getElementById('sw-browser-dl-styles')) {
                const style = document.createElement('style');
                style.id = 'sw-browser-dl-styles';
                style.textContent = `
                    .sw-browser-dl-btn, .sw-browser-dl-icon-btn { display:inline-flex; align-items:center; gap:5px; background:var(--sw-accent,#2f6fe4); color:#fff!important; border-radius:4px; padding:4px 9px; text-decoration:none!important; cursor:pointer; font-size:12px; }
                    .sw-browser-dl-icon-btn { margin-left:4px; padding:2px 6px; }
                    #sw-browser-downloads { display:none; color:var(--sw-text,#1b2233); background:var(--sw-surface,#fff); border:1px solid var(--sw-border,#c9d2e3); min-height:60vh; font:inherit; }
                    div.spots.sw-show-downloads > :not(.sw-tabs):not(#sw-browser-downloads) { display:none!important; }
                    .sw-show-downloads > #sw-browser-downloads { display:block; }
                    .sw-dl-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:12px; background:var(--sw-surface-2,#f3f6fb); border-bottom:1px solid var(--sw-border,#c9d2e3); }
                    .sw-dl-toolbar h2 { margin:0 auto 0 0; color:inherit; font-size:16px; }
                    .sw-dl-destination, .sw-dl-summary { color:var(--sw-muted,#5d6b85); font-size:12px; }
                    .sw-dl-summary { padding:8px 12px; border-bottom:1px solid var(--sw-border,#c9d2e3); }
                    .sw-dl-table-wrap { overflow:auto; }
                    .sw-dl-table { width:100%; border-collapse:collapse; font:inherit; table-layout:auto; }
                    .sw-dl-table th { text-align:left; padding:9px 10px; background:var(--sw-th,#edf1f8); color:var(--sw-muted,#5d6b85); white-space:nowrap; border-bottom:1px solid var(--sw-border,#c9d2e3); }
                    .sw-dl-table td { padding:12px 10px; vertical-align:top; border-bottom:1px solid var(--sw-border,#c9d2e3); }
                    .sw-dl-table tbody tr:hover { background:var(--sw-row-hover,#e6eefc); }
                    .sw-dl-title-cell { min-width:210px; max-width:400px; overflow-wrap:anywhere; }
                    .sw-dl-title { font-weight:600; }
                    .sw-dl-phase { margin-top:5px; font-size:12px; color:var(--sw-muted,#5d6b85); overflow-wrap:anywhere; }
                    .sw-dl-error { color:#c03932; }
                    .sw-dl-progress-cell { min-width:145px; }
                    .sw-dl-progress-track { height:10px; background:var(--sw-accent-soft,#e4edfc); border:1px solid var(--sw-border,#c9d2e3); border-radius:3px; overflow:hidden; margin:3px 0 5px; }
                    .sw-dl-progress-bar { height:100%; background:var(--sw-accent,#2f6fe4); transition:width .2s; }
                    .sw-dl-metric { white-space:nowrap; }
                    .sw-dl-state { font-weight:600; white-space:nowrap; color:var(--sw-accent,#2f6fe4); }
                    .sw-dl-state-failed { color:#c03932; }
                    .sw-dl-state-completed { color:#16844b; }
                    .sw-dl-card-actions { display:flex; gap:5px; flex-wrap:wrap; min-width:125px; }
                    .sw-dl-btn-sm, .sw-dl-header-btn { font:inherit; font-size:12px; cursor:pointer; padding:4px 9px; color:var(--sw-accent,#2f6fe4); background:var(--sw-surface,#fff); border:1px solid var(--sw-border,#c9d2e3); border-radius:4px; }
                    .sw-dl-btn-sm:hover, .sw-dl-header-btn:hover { background:var(--sw-accent-soft,#e4edfc); }
                    .sw-dl-btn-primary { color:#fff; background:var(--sw-accent,#2f6fe4); }
                    .sw-dl-btn-primary:hover { background:#245bc0; }
                    .sw-dl-btn-danger { color:#c03932; }
                    .sw-dl-pw-input { width:130px; font:inherit; padding:4px; }
                    .sw-dl-empty { padding:40px 20px!important; text-align:center; color:var(--sw-muted,#5d6b85); }
                    .sw-dl-badge { margin-left:6px; font-size:11px; padding:1px 5px; background:var(--sw-accent,#2f6fe4); color:#fff; border-radius:8px; }
                `;
                document.head.appendChild(style);
            }
            let panel = document.getElementById('sw-browser-downloads');
            if (!panel) {
                panel = document.createElement('section');
                panel.id = 'sw-browser-downloads';
                panel.setAttribute('aria-label', 'Downloads');
                panel.innerHTML = `<div class="sw-dl-toolbar"><h2>Downloads</h2>
                    <span class="sw-dl-destination" id="sw-dl-destination"></span>
                    <button type="button" class="sw-dl-header-btn" id="sw-dl-folder-btn">Choose download folder</button>
                    <button type="button" class="sw-dl-header-btn" id="sw-dl-clear-btn">Clear finished</button></div>
                    <div class="sw-dl-summary" id="sw-dl-summary" aria-live="polite"></div>
                    <div class="sw-dl-table-wrap" id="sw-browser-dl-list"></div>`;
                document.body.appendChild(panel);
                document.getElementById('sw-dl-clear-btn').addEventListener('click', () => this.clearCompletedJobs());
                document.getElementById('sw-dl-folder-btn').addEventListener('click', () => {
                    this.selectDestinationDirectory().catch(err => {
                        if (err.name !== 'AbortError') this._showNotification(err.message, 'error');
                    });
                });
            }
            const spots = document.querySelector('div.spots');
            if (spots && panel.parentNode !== spots) spots.appendChild(panel);
            if (spots) spots.classList.toggle('sw-show-downloads', this.panelOpen);
            document.querySelectorAll('.sw-tabs .sw-tab').forEach(t => {
                if (this.panelOpen) t.classList.toggle('active', t.classList.contains('sw-tab-downloads'));
                else if (t.classList.contains('sw-tab-downloads')) t.classList.remove('active');
            });
        }

        _renderUI() {
            if (typeof document === 'undefined') return;
            this._ensureStylesAndDom();
            const jobs = Array.from(this.jobs.values()).sort((a,b) => (a.createdAt || 0) - (b.createdAt || 0));
            const active = jobs.filter(j => !['completed','failed','cancelled'].includes(j.state));
            const speed = active.reduce((n,j) => n + (!j.paused && j.state === 'downloading' ? Number(j.speedBps) || 0 : 0), 0);
            const badge = document.getElementById('sw-nav-dl-badge');
            if (badge) { badge.textContent = active.length; badge.style.display = active.length ? '' : 'none'; }
            const folder = document.getElementById('sw-dl-destination');
            if (folder) folder.textContent = this.destinationDirectory ? 'Save to: ' + this.destinationDirectory.name : 'Choose a local folder before downloading';
            const summary = document.getElementById('sw-dl-summary');
            if (summary) summary.textContent = active.length + ' active · ' + jobs.filter(j=>j.state==='completed').length + ' completed · ' + formatBytes(speed) + '/s';
            const list = document.getElementById('sw-browser-dl-list');
            if (list) { list.innerHTML = this._buildJobsListHtml(jobs); this._bindCardActions(list); }
        }

        _buildJobsListHtml(jobs) {
            const rows = jobs.map(job => {
                const resumable = job.paused && !['completed', 'cancelled', 'failed'].includes(job.state);
                const stateLabel = resumable ? 'Paused' : (STATE_LABELS[job.state] || job.state);
                const pct = Math.max(0, Math.min(100, Number(job.progressPct) || 0));
                const moving = !job.paused && job.state === 'downloading';
                let actionsHtml = '';
                if (resumable || job.state === 'downloading' || job.state === 'queued') {
                    if (job.paused) {
                        actionsHtml += `<button type="button" class="sw-dl-btn-sm sw-dl-btn-primary" data-action="resume" data-job="${escapeHtml(job.jobId)}">Resume</button>`;
                    } else {
                        actionsHtml += `<button type="button" class="sw-dl-btn-sm" data-action="pause" data-job="${escapeHtml(job.jobId)}">Pause</button>`;
                    }
                    actionsHtml += `<button type="button" class="sw-dl-btn-sm sw-dl-btn-danger" data-action="cancel" data-job="${escapeHtml(job.jobId)}">Cancel</button>`;
                } else if (['verifying', 'repairing', 'extracting', 'finalizing'].includes(job.state)) {
                    actionsHtml += `<button type="button" class="sw-dl-btn-sm sw-dl-btn-danger" data-action="cancel" data-job="${escapeHtml(job.jobId)}">Cancel</button>`;
                } else if (job.state === 'password_required') {
                    actionsHtml += `
                        <input type="password" class="sw-dl-pw-input" placeholder="Archive password..." data-pw-input="${escapeHtml(job.jobId)}" />
                        <button type="button" class="sw-dl-btn-sm sw-dl-btn-primary" data-action="submit-pw" data-job="${escapeHtml(job.jobId)}">Extract</button>
                        <button type="button" class="sw-dl-btn-sm sw-dl-btn-danger" data-action="cancel" data-job="${escapeHtml(job.jobId)}">Cancel</button>
                    `;
                } else if (job.state === 'permission_required') {
                    actionsHtml += `
                        <button type="button" class="sw-dl-btn-sm sw-dl-btn-primary" data-action="grant-perm" data-job="${escapeHtml(job.jobId)}">Grant Folder Access</button>
                        <button type="button" class="sw-dl-btn-sm sw-dl-btn-danger" data-action="cancel" data-job="${escapeHtml(job.jobId)}">Cancel</button>
                    `;
                } else if (job.state === 'failed') {
                    actionsHtml += `
                        <button type="button" class="sw-dl-btn-sm sw-dl-btn-primary" data-action="resume" data-job="${escapeHtml(job.jobId)}">Retry</button>
                        <button type="button" class="sw-dl-btn-sm sw-dl-btn-danger" data-action="cancel" data-job="${escapeHtml(job.jobId)}">Remove</button>
                    `;
                } else if (job.state === 'completed' || job.state === 'cancelled') {
                    actionsHtml += `<button type="button" class="sw-dl-btn-sm" data-action="cancel" data-job="${escapeHtml(job.jobId)}">Remove</button>`;
                }


                return `<tr data-job-id="${escapeHtml(job.jobId)}">
                    <td class="sw-dl-title-cell"><div class="sw-dl-title">${escapeHtml(job.spotTitle)}</div>
                        <div class="sw-dl-phase">Folder: ${escapeHtml(job.dirName || 'Not selected')}</div>
                        <div class="sw-dl-phase ${job.state === 'failed' ? 'sw-dl-error' : ''}">${escapeHtml(job.phaseDetail || '')}</div></td>
                    <td class="sw-dl-progress-cell"><div class="sw-dl-progress-track" role="progressbar" aria-label="${escapeHtml(job.spotTitle)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="sw-dl-progress-bar" style="width:${pct}%"></div></div><span class="sw-dl-phase">${pct.toFixed(1)}%</span></td>
                    <td class="sw-dl-metric">${moving ? formatBytes(job.speedBps) + '/s' : '—'}${job.relayDiagnostics && moving ? `<div class="sw-dl-phase">${job.relayDiagnostics.transport === 'ws' ? 'WebSocket · ' + Number(job.relayDiagnostics.activeConnections) + ' connections' : 'HTTP' + (job.relayDiagnostics.fallbackReason ? ' fallback' : '')} · ${Number(job.relayDiagnostics.retries) || 0} retries</div>` : ''}</td>
                    <td><span class="sw-dl-state sw-dl-state-${escapeHtml(job.state)}">${escapeHtml(stateLabel)}</span></td>
                    <td class="sw-dl-metric">${formatBytes(job.totalBytes)}<div class="sw-dl-phase">${formatBytes(job.downloadedBytes)} received</div></td>
                    <td class="sw-dl-metric">${moving ? formatEta(job.etaSeconds) : '—'}</td>
                    <td><div class="sw-dl-card-actions">${actionsHtml}</div></td></tr>`;
            }).join('');
            return '<table class="sw-dl-table"><thead><tr><th>Title</th><th>Progress</th><th>Speed</th><th>Status</th><th>Size</th><th>Time remaining</th><th>Actions</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7" class="sw-dl-empty">No downloads yet. Choose a spot and click <strong>Download in browser</strong> to get started.</td></tr>') + '</tbody></table>';
        }

        _bindCardActions(container) {
            container.querySelectorAll('button[data-action]').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const action = btn.getAttribute('data-action');
                    const jobId = btn.getAttribute('data-job');
                    if (action === 'pause') {
                        this.pauseJob(jobId);
                    } else if (action === 'resume' || action === 'grant-perm') {
                        this.resumeJob(jobId).catch(err => this._showNotification(err.message, 'error'));
                    } else if (action === 'cancel') {
                        this.cancelJob(jobId);
                    } else if (action === 'submit-pw') {
                        const pwInput = container.querySelector(`input[data-pw-input="${CSS.escape(jobId)}"]`);
                        const pw = pwInput ? pwInput.value : '';
                        this.resumeJob(jobId, { password: pw }).catch(err => this._showNotification(err.message, 'error'));
                    }
                });
            });
        }
    }

    // Create global singleton & convenience helper in browser environment
    let singleton = null;
    function getManager() {
        if (!singleton) {
            singleton = new BrowserDownloadManager();
            if (typeof document !== 'undefined') {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', () => singleton.init());
                } else {
                    singleton.init();
                }
            }
        }
        return singleton;
    }

    if (typeof window !== 'undefined') {
        window.spotwebBrowserDownloadManager = getManager();
        document.addEventListener('sw:listswap', () => {
            const manager = getManager();
            manager.panelOpen = false;
            manager._renderUI();
        });
        window.spotwebDownloadInBrowser = function (messageIds, spotTitle, event) {
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
                event.stopPropagation();
            }
            getManager().startSpotDownload(messageIds, { spotTitle }).catch((err) => {
                console.error('[SpotwebBrowserDownload] startSpotDownload error:', err);
            });
            return false;
        };
        window.spotwebDownloadMultiInBrowser = function (event) {
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
                event.stopPropagation();
            }
            const selector = (window.spotwebMultiNzb && window.spotwebMultiNzb.selectedCheckboxSelector)
                || 'td.multinzb input[type=checkbox]:checked, span.multi input[type=checkbox]:checked';
            const checked = Array.from(document.querySelectorAll(selector));
            const messageIds = checked.map((el) => el.value).filter(Boolean);
            if (messageIds.length === 0) {
                return false;
            }
            getManager().startSpotDownload(messageIds, {
                spotTitle: messageIds.length === 1 ? 'Selected Spot' : `${messageIds.length} Selected Spots`
            }).then((jobId) => {
                if (jobId && typeof window.uncheckMultiNZB === 'function') {
                    try { window.uncheckMultiNZB(); } catch (_) {}
                }
            }).catch((err) => {
                console.error('[SpotwebBrowserDownload] multiSpotDownload error:', err);
            });
            return false;
        };
    }

    return {
        BrowserDownloadManager,
        getManager,
        formatBytes,
        formatEta
    };
}));
