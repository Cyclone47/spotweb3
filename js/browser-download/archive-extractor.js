/**
 * Spotweb Browser Download Engine - Disk-Backed Multipart Archive Extractor (7z-wasm + SyncHandleFS)
 * Supports RAR4, RAR5, ZIP/ZIP64, 7z, split volumes, passwords, obfuscated volume names, and strict path safety.
 * Runs in Browser Dedicated Web Worker and Node.js.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        var nzbParser = require('./nzb-parser.js');
        module.exports = factory(nzbParser);
    } else {
        root.SpotwebArchiveExtractor = factory(root.SpotwebNzbParser);
    }
}(typeof self !== 'undefined' ? self : this, function (SpotwebNzbParser) {
    'use strict';

    var validateAndSanitizeRelativePath = SpotwebNzbParser.validateAndSanitizeRelativePath;

    // =========================================================================
    // 1. Magic Byte & RAR Volume Header Inspector (De-obfuscates Volume Names)
    // =========================================================================
    function readVint(buf, offset) {
        var val = 0;
        var shift = 0;
        var pos = offset;
        while (pos < buf.length && shift < 64) {
            var b = buf[pos++];
            val += (b & 0x7f) * Math.pow(2, shift);
            if ((b & 0x80) === 0) {
                return { value: val, nextOffset: pos };
            }
            shift += 7;
        }
        return { value: val, nextOffset: pos };
    }

    /**
     * Inspect magic bytes (first 64 bytes) of a file to determine archive format and volume index.
     */
    function inspectFileMagic(headerBytes, filename) {
        var b = headerBytes;
        var lower = (filename || '').toLowerCase();

        // RAR5: 52 61 72 21 1A 07 01 00
        if (b.length >= 8 &&
            b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 &&
            b[4] === 0x1a && b[5] === 0x07 && b[6] === 0x01 && b[7] === 0x00) {
            var pos = 8 + 4; // skip 8-byte sig + 4-byte CRC32
            var hdrSize = readVint(b, pos);
            pos = hdrSize.nextOffset;
            var hdrType = readVint(b, pos);
            pos = hdrType.nextOffset;
            var hdrFlags = readVint(b, pos);
            pos = hdrFlags.nextOffset;

            var isEncryptedHeaders = (hdrType.value === 4); // HEAD_CRYPT
            var isMultiVolume = false;
            var volumeIndex = 0;

            if (hdrType.value === 1) { // HEAD_MAIN
                if (hdrFlags.value & 0x0001) { // HFL_EXTRA
                    var extraSz = readVint(b, pos);
                    pos = extraSz.nextOffset;
                }
                if (hdrFlags.value & 0x0002) { // HFL_DATA
                    var dataSz = readVint(b, pos);
                    pos = dataSz.nextOffset;
                }
                var arcFlags = readVint(b, pos);
                pos = arcFlags.nextOffset;
                isMultiVolume = (arcFlags.value & 0x0001) !== 0;
                if (arcFlags.value & 0x0002) { // MFL_VOLNUMBER
                    var volNo = readVint(b, pos);
                    volumeIndex = volNo.value;
                } else {
                    volumeIndex = 0;
                }
            } else {
                // Fallback to filename part number if header is encrypted
                var mPart = lower.match(/\.part(\d+)\.rar$/i);
                if (mPart) {
                    isMultiVolume = true;
                    volumeIndex = Math.max(0, parseInt(mPart[1], 10) - 1);
                }
            }

            return {
                isArchive: true,
                format: 'rar5',
                isMultiVolume: isMultiVolume,
                volumeIndex: volumeIndex,
                isFirstVolume: volumeIndex === 0,
                isEncryptedHeaders: isEncryptedHeaders
            };
        }

        // RAR4: 52 61 72 21 1A 07 00
        if (b.length >= 14 &&
            b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 &&
            b[4] === 0x1a && b[5] === 0x07 && b[6] === 0x00) {
            var headType = b[9];
            var headFlags = b[10] | (b[11] << 8);
            var isVol = (headFlags & 0x0001) !== 0;
            var newNum = (headFlags & 0x0010) !== 0;
            var isFirst = (headFlags & 0x0100) !== 0;
            var volIdx = 0;

            var pMatch = lower.match(/\.part(\d+)\.rar$/i);
            var rMatch = lower.match(/\.r(\d{2,3})$/i);
            if (pMatch) {
                volIdx = Math.max(0, parseInt(pMatch[1], 10) - 1);
                isFirst = (volIdx === 0);
            } else if (rMatch) {
                volIdx = parseInt(rMatch[1], 10) + 1;
                isFirst = false;
            } else if (isVol && !isFirst && headType === 0x73) {
                volIdx = 1;
            }

            return {
                isArchive: true,
                format: 'rar4',
                isMultiVolume: isVol,
                oldNumbering: isVol && !newNum && !pMatch,
                volumeIndex: volIdx,
                isFirstVolume: !isVol || isFirst || volIdx === 0,
                isEncryptedHeaders: (headFlags & 0x0080) !== 0
            };
        }

        // 7z: 37 7A BC AF 27 1C
        if (b.length >= 6 &&
            b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc &&
            b[3] === 0xaf && b[4] === 0x27 && b[5] === 0x1c) {
            return {
                isArchive: true,
                format: '7z',
                isMultiVolume: /\.7z\.001$/i.test(lower),
                volumeIndex: 0,
                isFirstVolume: true
            };
        }

        // ZIP: 50 4B 03 04 or 50 4B 05 06 or 50 4B 07 08
        if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b &&
            (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
            return {
                isArchive: true,
                format: 'zip',
                isMultiVolume: false,
                volumeIndex: 0,
                isFirstVolume: true
            };
        }

        // Split continuation volumes (.7z.002, .z01, .001, etc.)
        var split7z = lower.match(/\.7z\.(\d{3})$/i);
        if (split7z) {
            var idx7 = parseInt(split7z[1], 10) - 1;
            return {
                isArchive: true,
                format: '7z-split',
                isMultiVolume: true,
                volumeIndex: idx7,
                isFirstVolume: idx7 === 0
            };
        }

        return {
            isArchive: false,
            format: null,
            isMultiVolume: false,
            volumeIndex: 0,
            isFirstVolume: false
        };
    }

    // =========================================================================
    // 2. Zero-RAM SyncHandleFS Adapter for Emscripten (7z-wasm)
    // =========================================================================
    function attachSyncHandleFS(szModule, handleResolver, onWriteProgress) {
        var FS = szModule.FS;
        var MEMFS = FS.filesystems.MEMFS;
        var origStream = Object.assign({}, MEMFS.ops_table.file.stream);
        var origNode = Object.assign({}, MEMFS.ops_table.file.node);
        var totalWrittenBytes = 0;

        function getHandle(node) {
            if (node._syncHandle !== undefined) {
                return node._syncHandle;
            }
            var fullPath = FS.getPath(node);
            node._syncHandle = handleResolver(fullPath, node) || null;
            if (node._syncHandle) {
                node.usedBytes = node._syncHandle.getSize();
                node.contents = null;
            }
            return node._syncHandle;
        }

        MEMFS.ops_table.file.node.getattr = function (node) {
            var h = getHandle(node);
            if (h) {
                node.usedBytes = h.getSize();
            }
            return origNode.getattr(node);
        };

        MEMFS.ops_table.file.node.setattr = function (node, attr) {
            var h = getHandle(node);
            if (h) {
                var keys = ['mode', 'atime', 'mtime', 'ctime'];
                for (var i = 0; i < keys.length; i++) {
                    var k = keys[i];
                    if (attr[k] != null) {
                        node[k] = attr[k];
                    }
                }
                if (attr.size !== undefined) {
                    h.truncate(attr.size);
                    node.usedBytes = attr.size;
                }
                return;
            }
            return origNode.setattr(node, attr);
        };

        MEMFS.ops_table.file.stream.read = function (stream, buffer, offset, length, position) {
            var h = getHandle(stream.node);
            if (h) {
                var sz = h.getSize();
                if (position >= sz) {
                    return 0;
                }
                var toRead = Math.min(length, sz - position);
                var view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, toRead);
                return h.read(view, { at: position });
            }
            return origStream.read(stream, buffer, offset, length, position);
        };

        MEMFS.ops_table.file.stream.write = function (stream, buffer, offset, length, position, canOwn) {
            var fullPath = FS.getPath(stream.node);
            var h = getHandle(stream.node);
            if (fullPath.indexOf('/out/') === 0 && !h) {
                // Security guard: block any write to /out/ that was not pre-validated and mapped!
                throw new FS.ErrnoError(28); // EACCES / ENOSPC
            }
            if (h) {
                if (!length) {
                    return 0;
                }
                stream.node.mtime = stream.node.ctime = Date.now();
                var view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
                var written = h.write(view, { at: position });
                stream.node.usedBytes = h.getSize();
                totalWrittenBytes += written;
                if (typeof onWriteProgress === 'function') {
                    onWriteProgress(totalWrittenBytes, fullPath.slice(5));
                }
                return written;
            }
            return origStream.write(stream, buffer, offset, length, position, canOwn);
        };
    }

    // =========================================================================
    // 3. Parse `7zz l -slt` Output & Validate Entries
    // =========================================================================
    function parseSltListing(stdoutLines) {
        var entries = [];
        var inEntries = false;
        var current = null;

        for (var i = 0; i < stdoutLines.length; i++) {
            var line = stdoutLines[i].replace(/[\r\n]+$/, '');
            if (line === '----------') {
                inEntries = true;
                current = null;
                continue;
            }
            if (!inEntries) {
                continue;
            }
            if (line === '') {
                if (current && current.rawPath !== undefined) {
                    entries.push(current);
                }
                current = null;
                continue;
            }
            var eqIdx = line.indexOf(' = ');
            if (eqIdx > 0) {
                var key = line.slice(0, eqIdx).trim();
                var val = line.slice(eqIdx + 3).trim();
                if (!current) {
                    current = {
                        rawPath: undefined,
                        size: 0,
                        packedSize: 0,
                        isFolder: false,
                        encrypted: false
                    };
                }
                if (key === 'Path') {
                    current.rawPath = val;
                } else if (key === 'Size') {
                    current.size = parseInt(val, 10) || 0;
                } else if (key === 'Packed Size') {
                    current.packedSize = parseInt(val, 10) || 0;
                } else if (key === 'Folder') {
                    current.isFolder = (val === '+');
                } else if (key === 'Encrypted') {
                    current.encrypted = (val === '+');
                } else if (key === 'Attributes' && val.indexOf('D') === 0) {
                    current.isFolder = true;
                }
            }
        }
        if (current && current.rawPath !== undefined) {
            entries.push(current);
        }
        return entries;
    }

    /**
     * Load 7z-wasm factory and wasmBinary in either Node.js or Browser Web Worker.
     */
    function createSevenZipInstance(options, printCb, printErrCb) {
        var opts = options || {};
        var factoryFn = opts.sevenZipFactory || (typeof SevenZip !== 'undefined' ? SevenZip : null);
        if (!factoryFn && typeof require === 'function') {
            try {
                factoryFn = require('./vendor/7zz.umd.js');
            } catch (e) {
                factoryFn = require('7z-wasm');
            }
        }
        if (!factoryFn) {
            throw new Error('7z-wasm factory (SevenZip) is not loaded');
        }

        var moduleOpts = {
            print: printCb || function () {},
            printErr: printErrCb || function () {}
        };
        if (opts.wasmBinary) {
            moduleOpts.wasmBinary = opts.wasmBinary;
        } else if (opts.wasmUrl) {
            moduleOpts.locateFile = function (url) {
                if (url.indexOf('.wasm') !== -1) {
                    return opts.wasmUrl;
                }
                return url;
            };
        }
        return factoryFn(moduleOpts);
    }

    function ensureDirTreeInFS(FS, dirPath) {
        var parts = dirPath.split('/').filter(Boolean);
        var cur = '';
        for (var i = 0; i < parts.length; i++) {
            cur += '/' + parts[i];
            try {
                FS.mkdir(cur);
            } catch (e) {
                // Already exists
            }
        }
    }

    /**
     * Normalize and order input volume filenames, handling obfuscated RAR5/RAR4 volume names.
     *
     * @param {Array<{name: string, handle: Object}>} inputVolumes
     *   Each handle must expose sync: read(uint8View, {at}), getSize()
     */
    function prepareArchiveVolumes(inputVolumes) {
        var inspected = [];
        var hdrBuf = new Uint8Array(64);

        for (var i = 0; i < inputVolumes.length; i++) {
            var vol = inputVolumes[i];
            var sz = vol.handle.getSize();
            var toRead = Math.min(64, sz);
            hdrBuf.fill(0);
            if (toRead > 0) {
                vol.handle.read(hdrBuf.subarray(0, toRead), { at: 0 });
            }
            var info = inspectFileMagic(hdrBuf.subarray(0, toRead), vol.name);
            inspected.push({
                originalName: vol.name,
                virtualName: vol.name,
                handle: vol.handle,
                info: info
            });
        }

        // Check if we have RAR5 volumes with obfuscated names (i.e. not ending in .rar)
        var rar5Vols = inspected.filter(function (v) {
            return v.info.format === 'rar5';
        });

        if (rar5Vols.length > 0) {
            var anyNonRarName = rar5Vols.some(function (v) {
                return !/\.rar$/i.test(v.originalName);
            });
            if (anyNonRarName) {
                rar5Vols.sort(function (a, b) {
                    return a.info.volumeIndex - b.info.volumeIndex;
                });
                for (var r = 0; r < rar5Vols.length; r++) {
                    if (rar5Vols.length > 1 || rar5Vols[r].info.isMultiVolume) {
                        rar5Vols[r].virtualName = 'archive.part' + String(r + 1).padStart(3, '0') + '.rar';
                    } else {
                        rar5Vols[r].virtualName = 'archive.rar';
                    }
                }
            }
        }

        // Determine entry volume (first volume to pass to 7zz)
        var entryVolume = null;
        // Prefer RAR5/RAR4 first volume
        for (var k = 0; k < inspected.length; k++) {
            if (inspected[k].info.isArchive && inspected[k].info.isFirstVolume) {
                if (!entryVolume || inspected[k].info.volumeIndex < entryVolume.info.volumeIndex) {
                    entryVolume = inspected[k];
                }
            }
        }
        if (!entryVolume && inspected.length > 0) {
            entryVolume = inspected[0];
        }

        return {
            volumes: inspected,
            entryVolume: entryVolume
        };
    }

    function detectPasswordError(outputText) {
        if (/Wrong password/i.test(outputText)) {
            var err = new Error('Incorrect archive password');
            err.code = 'WRONG_PASSWORD';
            return err;
        }
        if (/Data Error in encrypted file|Cannot open encrypted archive|Encrypted\s*=\s*\+/i.test(outputText)) {
            var reqErr = new Error('Archive is password-protected');
            reqErr.code = 'PASSWORD_REQUIRED';
            return reqErr;
        }
        return null;
    }

    /**
     * Extract an archive (single or multi-volume RAR4, RAR5, ZIP, 7z) using disk-backed SyncAccessHandles.
     *
     * @param {Object} params
     * @param {Array<{name: string, handle: Object}>} params.inputVolumes
     * @param {Function} params.createOutputHandle (sanitizedRelPath, expectedSize) -> SyncAccessHandle
     * @param {string} [params.password] Optional archive password
     * @param {Function} [params.onProgress] ({ phase, extractedBytes, totalBytes, currentFile })
     * @param {Object} [params.wasmOptions] { sevenZipFactory, wasmBinary, wasmUrl }
     */
    async function extractArchive(params) {
        var inputVolumes = params.inputVolumes || [];
        var createOutputHandle = params.createOutputHandle;
        var password = params.password !== undefined && params.password !== null ? String(params.password) : '';
        var onProgress = params.onProgress || null;
        var wasmOptions = params.wasmOptions || {};

        if (inputVolumes.length === 0) {
            throw new Error('No archive volumes provided for extraction');
        }
        if (typeof createOutputHandle !== 'function') {
            throw new Error('createOutputHandle callback is required for disk-backed extraction');
        }

        var prepared = prepareArchiveVolumes(inputVolumes);
        var entryVol = prepared.entryVolume;
        if (!entryVol) {
            throw new Error('Could not identify primary archive volume');
        }

        var inputHandleMap = Object.create(null);
        for (var i = 0; i < prepared.volumes.length; i++) {
            var v = prepared.volumes[i];
            inputHandleMap['/in/' + v.virtualName] = v.handle;
        }

        // Step 1: Run `7zz l -slt` to inspect archive contents & validate all paths before extraction
        var listStdout = [];
        var listStderr = [];
        var szList = await createSevenZipInstance(
            wasmOptions,
            function (s) { listStdout.push(s); },
            function (s) { listStderr.push(s); }
        );

        attachSyncHandleFS(szList, function (fullPath) {
            return inputHandleMap[fullPath] || null;
        });

        szList.FS.mkdir('/in');
        for (var m = 0; m < prepared.volumes.length; m++) {
            var volName = prepared.volumes[m].virtualName;
            szList.FS.writeFile('/in/' + volName, new Uint8Array(0));
        }

        szList.callMain(['l', '-slt', '-y', '-p' + password, '/in/' + entryVol.virtualName]);
        var combinedListOut = listStdout.concat(listStderr).join('\n');

        if (/Errors:\s*[1-9]/i.test(combinedListOut) || /Cannot open/i.test(combinedListOut)) {
            var pwErr = detectPasswordError(combinedListOut);
            if (pwErr) {
                throw pwErr;
            }
            throw new Error('Failed to list archive contents: ' + combinedListOut.trim());
        }

        var entries = parseSltListing(listStdout);
        var fileEntries = [];
        var totalUnpackedBytes = 0;
        var usedPathsLower = Object.create(null);
        var outputHandlesByVirtualPath = Object.create(null);
        var outputFilesList = [];

        // Validate and sanitize every path BEFORE extracting any bytes!
        for (var e = 0; e < entries.length; e++) {
            var entry = entries[e];
            var safeRelPath = validateAndSanitizeRelativePath(entry.rawPath);
            if (entry.isFolder) {
                continue;
            }

            // Deterministic collision handling for duplicate/case-colliding paths
            var finalRelPath = safeRelPath;
            var collisionIdx = 1;
            while (usedPathsLower[finalRelPath.toLowerCase()]) {
                var slashIdx = safeRelPath.lastIndexOf('/');
                var dirPrefix = slashIdx >= 0 ? safeRelPath.slice(0, slashIdx + 1) : '';
                var baseName = slashIdx >= 0 ? safeRelPath.slice(slashIdx + 1) : safeRelPath;
                var dotIdx = baseName.lastIndexOf('.');
                if (dotIdx > 0) {
                    finalRelPath = dirPrefix + baseName.slice(0, dotIdx) + '_' + collisionIdx + baseName.slice(dotIdx);
                } else {
                    finalRelPath = dirPrefix + baseName + '_' + collisionIdx;
                }
                collisionIdx++;
            }
            usedPathsLower[finalRelPath.toLowerCase()] = true;

            // Internal virtual path in /out matches entry's normalized path so 7zz finds it
            var internalRelPath = entry.rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
            var virtualOutPath = '/out/' + internalRelPath;

            var outHandle = await createOutputHandle(finalRelPath, entry.size);
            outputHandlesByVirtualPath[virtualOutPath] = outHandle;
            var fileRecord = {
                rawPath: entry.rawPath,
                safePath: finalRelPath,
                virtualPath: virtualOutPath,
                expectedSize: entry.size,
                encrypted: entry.encrypted,
                handle: outHandle
            };
            fileEntries.push(fileRecord);
            outputFilesList.push(fileRecord);
            totalUnpackedBytes += entry.size;
        }

        // Step 2: Run `7zz x` with SyncHandleFS mapping both /in and /out directly to disk handles!
        var extStdout = [];
        var extStderr = [];
        var szExtract = await createSevenZipInstance(
            wasmOptions,
            function (s) { extStdout.push(s); },
            function (s) { extStderr.push(s); }
        );

        attachSyncHandleFS(
            szExtract,
            function (fullPath) {
                if (inputHandleMap[fullPath]) {
                    return inputHandleMap[fullPath];
                }
                if (outputHandlesByVirtualPath[fullPath]) {
                    return outputHandlesByVirtualPath[fullPath];
                }
                return null;
            },
            function (writtenBytes, currentRelPath) {
                if (typeof onProgress === 'function') {
                    onProgress({
                        phase: 'extracting',
                        extractedBytes: writtenBytes,
                        totalBytes: totalUnpackedBytes,
                        currentFile: currentRelPath
                    });
                }
            }
        );

        szExtract.FS.mkdir('/in');
        szExtract.FS.mkdir('/out');

        for (var vIdx = 0; vIdx < prepared.volumes.length; vIdx++) {
            szExtract.FS.writeFile('/in/' + prepared.volumes[vIdx].virtualName, new Uint8Array(0));
        }

        // Pre-create directory structure in /out so 7zz can open nested files seamlessly
        for (var fIdx = 0; fIdx < fileEntries.length; fIdx++) {
            var vp = fileEntries[fIdx].virtualPath;
            var lastSlash = vp.lastIndexOf('/');
            if (lastSlash > 4) {
                ensureDirTreeInFS(szExtract.FS, vp.slice(0, lastSlash));
            }
        }

        szExtract.callMain(['x', '-y', '-p' + password, '-o/out', '/in/' + entryVol.virtualName]);
        var combinedExtOut = extStdout.concat(extStderr).join('\n');

        if (!/Everything is Ok/i.test(combinedExtOut) || /Sub items Errors:\s*[1-9]/i.test(combinedExtOut)) {
            var extPwErr = detectPasswordError(combinedExtOut);
            if (extPwErr) {
                throw extPwErr;
            }
            throw new Error('Archive extraction failed: ' + combinedExtOut.trim());
        }

        // Verify all extracted file sizes and flush handles
        for (var o = 0; o < outputFilesList.length; o++) {
            var rec = outputFilesList[o];
            if (typeof rec.handle.flush === 'function') {
                rec.handle.flush();
            }
            var actualSize = rec.handle.getSize();
            if (actualSize !== rec.expectedSize) {
                throw new Error(
                    'Extracted file "' + rec.safePath + '" size mismatch: expected ' +
                    rec.expectedSize + ' bytes, got ' + actualSize + ' bytes'
                );
            }
        }

        return {
            format: entryVol.info.format || 'archive',
            isMultiVolume: entryVol.info.isMultiVolume,
            totalBytes: totalUnpackedBytes,
            extractedFiles: outputFilesList.map(function (f) {
                return {
                    path: f.safePath,
                    size: f.expectedSize
                };
            })
        };
    }

    return {
        inspectFileMagic: inspectFileMagic,
        prepareArchiveVolumes: prepareArchiveVolumes,
        parseSltListing: parseSltListing,
        attachSyncHandleFS: attachSyncHandleFS,
        extractArchive: extractArchive
    };
}));
