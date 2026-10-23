/**
 * Spotweb Browser Download Engine - Durable Storage & Checkpoint Manager
 *
 * Responsibilities:
 * 1. IndexedDB persistence (`spotweb_browser_downloads`):
 *    - `jobs` object store: job state, parsed NZB plan, progress metrics, error info,
 *      and structured-cloned `FileSystemDirectoryHandle` for tab reload recovery.
 *    - `segments` object store: completed segment checkpoints (`jobId`, `fileIndex`,
 *      `partNumber`, `begin`, `end`, `size`, `crc32`) so interrupted downloads resume
 *      without re-downloading verified segments.
 *
 * 2. OPFS (Origin Private File System) staging (`navigator.storage.getDirectory()`):
 *    - Provides random-access `SyncHandleAdapter` objects backed by
 *      `FileSystemSyncAccessHandle` in Dedicated Web Workers (fastest, synchronous
 *      zero-copy random I/O for out-of-order yEnc segments, PAR2 repair, and `7z-wasm`).
 *    - Provides an in-memory / writable-stream fallback for environments without
 *      `createSyncAccessHandle`.
 *
 * 3. Final Local Folder Commit (`FileSystemDirectoryHandle`):
 *    - Verifies and re-requests `readwrite` permission on the user-chosen folder.
 *    - Copies verified/repaired/extracted files from OPFS staging into the user's
 *      selected folder (preserving safe relative subdirectories if any) and cleans up
 *      OPFS staging storage immediately on completion or cancellation.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./nzb-parser.js'));
    } else {
        root.SpotwebStorageManager = factory(root.SpotwebNzbParser);
    }
}(typeof self !== 'undefined' ? self : this, function (NzbParser) {
    'use strict';

    const DB_NAME = 'spotweb_browser_downloads';
    const DB_VERSION = 1;
    const STORE_JOBS = 'jobs';
    const STORE_SEGMENTS = 'segments';
    const OPFS_ROOT_DIR = 'spotweb-downloads';

    /**
     * IndexedDB wrapper for job manifests and segment checkpoints.
     */
    class CheckpointStore {
        constructor(indexedDBImpl) {
            this.indexedDB = indexedDBImpl || (typeof indexedDB !== 'undefined' ? indexedDB : null);
            this.dbPromise = null;
            // In-memory fallback when running in Node tests without fake-indexeddb
            this.memJobs = new Map();
            this.memSegments = new Map();
        }

        async open() {
            if (!this.indexedDB) {
                return null;
            }
            if (this.dbPromise) {
                return this.dbPromise;
            }
            this.dbPromise = new Promise((resolve, reject) => {
                const req = this.indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(STORE_JOBS)) {
                        const jobStore = db.createObjectStore(STORE_JOBS, { keyPath: 'jobId' });
                        jobStore.createIndex('createdAt', 'createdAt', { unique: false });
                        jobStore.createIndex('state', 'state', { unique: false });
                    }
                    if (!db.objectStoreNames.contains(STORE_SEGMENTS)) {
                        const segStore = db.createObjectStore(STORE_SEGMENTS, { keyPath: 'key' });
                        segStore.createIndex('jobId', 'jobId', { unique: false });
                        segStore.createIndex('jobFile', ['jobId', 'fileIndex'], { unique: false });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
            });
            return this.dbPromise;
        }

        async saveJob(jobRecord) {
            const db = await this.open();
            if (!db) {
                this.memJobs.set(jobRecord.jobId, Object.assign({}, jobRecord));
                return;
            }
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_JOBS, 'readwrite');
                tx.objectStore(STORE_JOBS).put(jobRecord);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        async getJob(jobId) {
            const db = await this.open();
            if (!db) {
                return this.memJobs.get(jobId) || null;
            }
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_JOBS, 'readonly');
                const req = tx.objectStore(STORE_JOBS).get(jobId);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        }

        async listJobs() {
            const db = await this.open();
            if (!db) {
                return Array.from(this.memJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            }
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_JOBS, 'readonly');
                const req = tx.objectStore(STORE_JOBS).getAll();
                req.onsuccess = () => {
                    const list = req.result || [];
                    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                    resolve(list);
                };
                req.onerror = () => reject(req.error);
            });
        }

        async deleteJob(jobId) {
            await this.deleteJobSegments(jobId);
            const db = await this.open();
            if (!db) {
                this.memJobs.delete(jobId);
                return;
            }
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_JOBS, 'readwrite');
                tx.objectStore(STORE_JOBS).delete(jobId);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        async saveSegmentCheckpoint(checkpoint) {
            return this.saveSegmentCheckpointsBatch([checkpoint]);
        }

        async saveSegmentCheckpointsBatch(checkpoints) {
            if (!checkpoints || checkpoints.length === 0) {
                return;
            }
            const db = await this.open();
            if (!db) {
                for (let i = 0; i < checkpoints.length; i++) {
                    const cp = checkpoints[i];
                    const key = `${cp.jobId}:${cp.fileIndex}:${cp.partNumber}`;
                    this.memSegments.set(key, {
                        key,
                        jobId: cp.jobId,
                        fileIndex: cp.fileIndex,
                        partNumber: cp.partNumber,
                        begin: cp.begin,
                        end: cp.end,
                        size: cp.size,
                        crc32: cp.crc32
                    });
                }
                return;
            }
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_SEGMENTS, 'readwrite');
                const store = tx.objectStore(STORE_SEGMENTS);
                for (let i = 0; i < checkpoints.length; i++) {
                    const cp = checkpoints[i];
                    store.put({
                        key: `${cp.jobId}:${cp.fileIndex}:${cp.partNumber}`,
                        jobId: cp.jobId,
                        fileIndex: cp.fileIndex,
                        partNumber: cp.partNumber,
                        begin: cp.begin,
                        end: cp.end,
                        size: cp.size,
                        crc32: cp.crc32
                    });
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        async getJobSegments(jobId) {
            const db = await this.open();
            if (!db) {
                const out = [];
                for (const seg of this.memSegments.values()) {
                    if (seg.jobId === jobId) out.push(seg);
                }
                return out;
            }
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_SEGMENTS, 'readonly');
                const index = tx.objectStore(STORE_SEGMENTS).index('jobId');
                const req = index.getAll(jobId);
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        }

        async deleteJobSegments(jobId) {
            const db = await this.open();
            if (!db) {
                for (const [k, v] of this.memSegments.entries()) {
                    if (v.jobId === jobId) this.memSegments.delete(k);
                }
                return;
            }
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_SEGMENTS, 'readwrite');
                const store = tx.objectStore(STORE_SEGMENTS);
                const index = store.index('jobId');
                const req = index.openKeyCursor(IDBKeyRange.only(jobId));
                req.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        store.delete(cursor.primaryKey);
                        cursor.continue();
                    }
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }
    }

    /**
     * Wraps a Browser `FileSystemSyncAccessHandle` in the standard synchronous handle
     * interface consumed by `par2-engine.js`, `archive-extractor.js`, and `download-worker.js`.
     */
    class OpfsSyncFileHandle {
        constructor(syncAccessHandle, name) {
            this.handle = syncAccessHandle;
            this.name = name || '';
            this.closed = false;
        }

        getSize() {
            return this.handle.getSize();
        }

        read(view, opts = {}) {
            const at = opts.at !== undefined ? opts.at : 0;
            return this.handle.read(view, { at });
        }

        write(view, opts = {}) {
            const at = opts.at !== undefined ? opts.at : 0;
            return this.handle.write(view, { at });
        }

        truncate(newSize) {
            this.handle.truncate(newSize);
        }

        flush() {
            this.handle.flush();
        }

        close() {
            if (!this.closed) {
                this.closed = true;
                try { this.handle.flush(); } catch (_) {}
                try { this.handle.close(); } catch (_) {}
            }
        }
    }

    /**
     * Manages an OPFS staging workspace for a single download job (`spotweb-downloads/<jobId>`).
     */
    class OpfsJobWorkspace {
        constructor(jobId, jobDirHandle, stagingDirHandle, extractedDirHandle) {
            this.jobId = jobId;
            this.jobDirHandle = jobDirHandle;
            this.stagingDirHandle = stagingDirHandle;
            this.extractedDirHandle = extractedDirHandle;
            this.openHandles = new Map(); // key -> OpfsSyncFileHandle
            this.pendingHandles = new Map(); // key -> Promise<OpfsSyncFileHandle>
        }

        /**
         * Opens (or returns an already open) synchronous access handle in `staging` or `extracted`.
         * Note: `createSyncAccessHandle()` is available inside Dedicated Web Workers in Chrome/Edge/Firefox/Safari.
         *
         * @param {'staging'|'extracted'} area
         * @param {string} filename
         * @returns {Promise<OpfsSyncFileHandle>}
         */
        async openSyncHandle(area, filename) {
            const safeName = NzbParser ? NzbParser.sanitizeFilename(filename) : filename.replace(/[\/\\]/g, '_');
            const key = `${area}:${safeName}`;
            const existing = this.openHandles.get(key);
            if (existing && !existing.closed) {
                return existing;
            }
            const pending = this.pendingHandles.get(key);
            if (pending) {
                return pending;
            }

            const openPromise = (async () => {
                try {
                    const dir = area === 'extracted' ? this.extractedDirHandle : this.stagingDirHandle;
                    const fileHandle = await dir.getFileHandle(safeName, { create: true });
                    const syncAccess = await fileHandle.createSyncAccessHandle();
                    const wrapped = new OpfsSyncFileHandle(syncAccess, safeName);
                    this.openHandles.set(key, wrapped);
                    return wrapped;
                } finally {
                    this.pendingHandles.delete(key);
                }
            })();

            this.pendingHandles.set(key, openPromise);
            return openPromise;
        }

        async destroy() {
            this.closeAllHandles();
            await cleanupOpfsJobWorkspace(this.jobId);
        }

        closeSyncHandle(area, filename) {
            const safeName = NzbParser ? NzbParser.sanitizeFilename(filename) : filename.replace(/[\/\\]/g, '_');
            const key = `${area}:${safeName}`;
            const existing = this.openHandles.get(key);
            if (existing) {
                existing.close();
                this.openHandles.delete(key);
            }
        }

        closeAllHandles() {
            for (const handle of this.openHandles.values()) {
                handle.close();
            }
            this.openHandles.clear();
        }

        async renameStagingFile(oldName, newName) {
            const safeOld = NzbParser ? NzbParser.sanitizeFilename(oldName) : oldName;
            const safeNew = NzbParser ? NzbParser.sanitizeFilename(newName) : newName;
            if (safeOld === safeNew) return;

            this.closeSyncHandle('staging', safeOld);
            this.closeSyncHandle('staging', safeNew);

            const oldFileHandle = await this.stagingDirHandle.getFileHandle(safeOld, { create: false });
            if (typeof oldFileHandle.move === 'function') {
                await oldFileHandle.move(this.stagingDirHandle, safeNew);
                return;
            }

            // Stream copy if .move() is not supported
            const srcH = await this.openSyncHandle('staging', safeOld);
            const dstH = await this.openSyncHandle('staging', safeNew);
            const total = srcH.getSize();
            dstH.truncate(total);
            const buf = new Uint8Array(Math.min(1024 * 1024, Math.max(1, total)));
            let offset = 0;
            while (offset < total) {
                const len = Math.min(buf.length, total - offset);
                const view = buf.subarray(0, len);
                srcH.read(view, { at: offset });
                dstH.write(view, { at: offset });
                offset += len;
            }
            srcH.close();
            dstH.close();
            this.openHandles.delete(`staging:${safeOld}`);
            this.openHandles.delete(`staging:${safeNew}`);
            await this.stagingDirHandle.removeEntry(safeOld);
        }

        async removeStagingFile(filename) {
            const safeName = NzbParser ? NzbParser.sanitizeFilename(filename) : filename;
            this.closeSyncHandle('staging', safeName);
            try {
                await this.stagingDirHandle.removeEntry(safeName);
            } catch (_) {}
        }

        async listFiles(area) {
            const dir = area === 'extracted' ? this.extractedDirHandle : this.stagingDirHandle;
            const entries = [];
            for await (const [name, handle] of dir.entries()) {
                if (handle.kind === 'file') {
                    entries.push({ name, handle });
                }
            }
            return entries;
        }
    }

    /**
     * Checks storage quota and ensures sufficient free space for staging + extraction.
     *
     * @param {number} requiredBytes
     * @returns {Promise<{ ok: boolean, quota: number, usage: number, available: number }>}
     */
    async function checkStorageQuota(requiredBytes) {
        if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
            try {
                const est = await navigator.storage.estimate();
                const quota = est.quota || 0;
                const usage = est.usage || 0;
                const available = Math.max(0, quota - usage);
                if (quota > 0 && requiredBytes > 0 && available < requiredBytes) {
                    return { ok: false, quota, usage, available };
                }
                return { ok: true, quota, usage, available };
            } catch (_) {}
        }
        return { ok: true, quota: 0, usage: 0, available: Infinity };
    }

    /**
     * Opens or creates an OPFS workspace for `jobId`.
     * @param {string} jobId
     * @returns {Promise<OpfsJobWorkspace>}
     */
    async function openOpfsJobWorkspace(jobId) {
        if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
            throw new Error('Origin Private File System (OPFS) is not supported in this browser context');
        }
        const root = await navigator.storage.getDirectory();
        const dlRoot = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
        const jobDir = await dlRoot.getDirectoryHandle(String(jobId), { create: true });
        const stagingDir = await jobDir.getDirectoryHandle('staging', { create: true });
        const extractedDir = await jobDir.getDirectoryHandle('extracted', { create: true });
        return new OpfsJobWorkspace(String(jobId), jobDir, stagingDir, extractedDir);
    }

    /**
     * Deletes the entire OPFS directory for `jobId`.
     * @param {string} jobId
     */
    async function cleanupOpfsJobWorkspace(jobId) {
        if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
            return;
        }
        try {
            const root = await navigator.storage.getDirectory();
            const dlRoot = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: false });
            await dlRoot.removeEntry(String(jobId), { recursive: true });
        } catch (_) {}
    }

    /**
     * Verifies (and optionally requests on the main thread) readwrite permission on a
     * `FileSystemDirectoryHandle`.
     *
     * @param {FileSystemDirectoryHandle} dirHandle
     * @param {boolean} [promptUser=false]
     * @returns {Promise<'granted'|'prompt'|'denied'>}
     */
    async function verifyDirectoryPermission(dirHandle, promptUser = false) {
        if (!dirHandle) return 'denied';
        const opts = { mode: 'readwrite' };
        if (typeof dirHandle.queryPermission === 'function') {
            const state = await dirHandle.queryPermission(opts);
            if (state === 'granted') return 'granted';
            if (promptUser && typeof dirHandle.requestPermission === 'function') {
                return await dirHandle.requestPermission(opts);
            }
            return state;
        }
        return 'granted';
    }

    /**
     * Streams a staged/extracted file from an OPFS FileSystemFileHandle (or SyncHandle)
     * into the user's selected destination `FileSystemDirectoryHandle`, creating any
     * safe relative subdirectories and avoiding accidental overwrites if needed.
     *
     * @param {FileSystemDirectoryHandle} targetRootDirHandle
     * @param {string} relativeSafePath - e.g. "Album/01-Track.mp3" or "Movie.mkv"
     * @param {FileSystemFileHandle} opfsFileHandle
     * @param {function(number): void} [onBytesCopied]
     * @returns {Promise<{ finalPath: string, bytesWritten: number }>}
     */
    async function exportOpfsFileToUserDirectory(targetRootDirHandle, relativeSafePath, opfsFileHandle, onBytesCopied) {
        const cleanRel = NzbParser
            ? NzbParser.validateAndSanitizeRelativePath(relativeSafePath)
            : relativeSafePath.replace(/^\/+/, '');
        const parts = cleanRel.split('/').filter(Boolean);
        const fileName = parts.pop() || 'download.bin';

        let currentDir = targetRootDirHandle;
        for (let i = 0; i < parts.length; i++) {
            currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true });
        }

        const destFileHandle = await currentDir.getFileHandle(fileName, { create: true });
        const writable = await destFileHandle.createWritable({ keepExistingData: false });

        let bytesWritten = 0;
        try {
            const fileBlob = await opfsFileHandle.getFile();
            const totalSize = fileBlob.size;
            const chunkSize = 4 * 1024 * 1024; // 4 MB chunks for low memory & fast streaming

            let offset = 0;
            while (offset < totalSize) {
                const end = Math.min(offset + chunkSize, totalSize);
                const slice = fileBlob.slice(offset, end);
                const buf = await slice.arrayBuffer();
                await writable.write(buf);
                const len = end - offset;
                bytesWritten += len;
                offset = end;
                if (onBytesCopied) onBytesCopied(len);
            }
            await writable.close();
        } catch (err) {
            try { await writable.abort(); } catch (_) {}
            throw err;
        }

        return { finalPath: cleanRel, bytesWritten };
    }

    return {
        DB_NAME,
        CheckpointStore,
        OpfsSyncFileHandle,
        OpfsJobWorkspace,
        checkStorageQuota,
        openOpfsJobWorkspace,
        cleanupOpfsJobWorkspace,
        verifyDirectoryPermission,
        exportOpfsFileToUserDirectory
    };
}));
