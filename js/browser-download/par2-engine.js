/**
 * Spotweb Browser Download Engine - Disk-Backed PAR2 2.0 Verifier & GF(2^16) Reed-Solomon Repair Engine
 * Runs in Browser Main Thread, Dedicated Web Worker, and Node.js.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        var yenc = require('./yenc-decoder.js');
        module.exports = factory(yenc);
    } else {
        var exp = factory(root.SpotwebYencDecoder || root.SpotwebYenc);
        root.SpotwebPar2Engine = exp;
        root.SpotwebPar2 = exp;
    }
}(typeof self !== 'undefined' ? self : this, function (SpotwebYenc) {
    'use strict';

    var crc32Update = SpotwebYenc.crc32Update;
    var crc32 = SpotwebYenc.crc32;

    // =========================================================================
    // 1. Streaming RFC 1321 MD5 Implementation (TypedArray, zero external deps)
    // =========================================================================
    var MD5_K = new Uint32Array([
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
    ]);

    var MD5_S = new Uint8Array([
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ]);

    function Md5Hasher() {
        this.state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
        this.buffer = new Uint8Array(64);
        this.bufLen = 0;
        this.totalBytes = 0;
        this.words = new Uint32Array(16);
    }

    Md5Hasher.prototype._transform = function (block, offset) {
        var w = this.words;
        for (var i = 0; i < 16; i++) {
            var j = offset + (i << 2);
            w[i] = (block[j]) | (block[j + 1] << 8) | (block[j + 2] << 16) | (block[j + 3] << 24);
        }

        var a = this.state[0];
        var b = this.state[1];
        var c = this.state[2];
        var d = this.state[3];

        for (var k = 0; k < 64; k++) {
            var f, g;
            if (k < 16) {
                f = (b & c) | ((~b) & d);
                g = k;
            } else if (k < 32) {
                f = (d & b) | ((~d) & c);
                g = (5 * k + 1) & 15;
            } else if (k < 48) {
                f = b ^ c ^ d;
                g = (3 * k + 5) & 15;
            } else {
                f = c ^ (b | (~d));
                g = (7 * k) & 15;
            }
            var temp = d;
            d = c;
            c = b;
            var sum = (a + f + MD5_K[k] + w[g]) | 0;
            var s = MD5_S[k];
            b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
            a = temp;
        }

        this.state[0] = (this.state[0] + a) | 0;
        this.state[1] = (this.state[1] + b) | 0;
        this.state[2] = (this.state[2] + c) | 0;
        this.state[3] = (this.state[3] + d) | 0;
    };

    Md5Hasher.prototype.update = function (data, offset, length) {
        var pos = offset || 0;
        var rem = length !== undefined ? length : (data.length - pos);
        this.totalBytes += rem;

        if (this.bufLen > 0) {
            var take = Math.min(64 - this.bufLen, rem);
            this.buffer.set(data.subarray(pos, pos + take), this.bufLen);
            this.bufLen += take;
            pos += take;
            rem -= take;
            if (this.bufLen === 64) {
                this._transform(this.buffer, 0);
                this.bufLen = 0;
            }
        }

        while (rem >= 64) {
            this._transform(data, pos);
            pos += 64;
            rem -= 64;
        }

        if (rem > 0) {
            this.buffer.set(data.subarray(pos, pos + rem), 0);
            this.bufLen = rem;
        }
        return this;
    };

    Md5Hasher.prototype.digest = function () {
        var pad = new Uint8Array(this.bufLen < 56 ? (64 - this.bufLen) : (128 - this.bufLen));
        pad[0] = 0x80;
        var bitLenLo = (this.totalBytes * 8) >>> 0;
        var bitLenHi = Math.floor((this.totalBytes * 8) / 0x100000000) >>> 0;
        var lenOffset = pad.length - 8;
        pad[lenOffset] = bitLenLo & 0xff;
        pad[lenOffset + 1] = (bitLenLo >>> 8) & 0xff;
        pad[lenOffset + 2] = (bitLenLo >>> 16) & 0xff;
        pad[lenOffset + 3] = (bitLenLo >>> 24) & 0xff;
        pad[lenOffset + 4] = bitLenHi & 0xff;
        pad[lenOffset + 5] = (bitLenHi >>> 8) & 0xff;
        pad[lenOffset + 6] = (bitLenHi >>> 16) & 0xff;
        pad[lenOffset + 7] = (bitLenHi >>> 24) & 0xff;

        this.update(pad, 0, pad.length);
        var out = new Uint8Array(16);
        for (var i = 0; i < 4; i++) {
            var v = this.state[i];
            out[i * 4] = v & 0xff;
            out[i * 4 + 1] = (v >>> 8) & 0xff;
            out[i * 4 + 2] = (v >>> 16) & 0xff;
            out[i * 4 + 3] = (v >>> 24) & 0xff;
        }
        return out;
    };

    Md5Hasher.prototype.digestHex = function () {
        return bytesToHex(this.digest());
    };

    function md5(data, offset, length) {
        return new Md5Hasher().update(data, offset, length).digest();
    }

    function md5Hex(data, offset, length) {
        return bytesToHex(md5(data, offset, length));
    }

    function bytesToHex(bytes) {
        var hex = '';
        for (var i = 0; i < bytes.length; i++) {
            var b = bytes[i].toString(16);
            hex += b.length === 1 ? ('0' + b) : b;
        }
        return hex;
    }

    function hexToBytes(hex) {
        var out = new Uint8Array(hex.length >>> 1);
        for (var i = 0; i < out.length; i++) {
            out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    function bytesEqual(a, b) {
        if (a.length !== b.length) {
            return false;
        }
        for (var i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    // Compare two 16-byte PAR2 file_ids as 128-bit unsigned little-endian integers (PAR 2.0 spec)
    function compareFileIdsLE(idHexA, idHexB) {
        var a = hexToBytes(idHexA);
        var b = hexToBytes(idHexB);
        for (var i = 15; i >= 0; i--) {
            if (a[i] !== b[i]) {
                return a[i] - b[i];
            }
        }
        return 0;
    }

    // =========================================================================
    // 2. Galois Field GF(2^16) Arithmetic (Primitive Polynomial 0x1100B)
    // =========================================================================
    var GF_POLY = 0x1100b;
    var gfExp = new Uint16Array(131070);
    var gfLog = new Uint16Array(65536);

    (function initGfTables() {
        var x = 1;
        for (var i = 0; i < 65535; i++) {
            gfExp[i] = x;
            gfExp[i + 65535] = x;
            gfLog[x] = i;
            x <<= 1;
            if (x & 0x10000) {
                x ^= GF_POLY;
            }
        }
        gfLog[0] = 0;
    }());

    function gfMul(a, b) {
        if (a === 0 || b === 0) {
            return 0;
        }
        return gfExp[gfLog[a] + gfLog[b]];
    }

    function gfDiv(a, b) {
        if (b === 0) {
            throw new Error('GF(2^16) division by zero');
        }
        if (a === 0) {
            return 0;
        }
        return gfExp[gfLog[a] + 65535 - gfLog[b]];
    }

    function gfPow(a, exp) {
        if (exp === 0) {
            return 1;
        }
        if (a === 0) {
            return 0;
        }
        return gfExp[(gfLog[a] * (exp % 65535)) % 65535];
    }

    var par2BaseCache = [];
    function getPar2Base(sliceIndex) {
        while (par2BaseCache.length <= sliceIndex) {
            var p = par2BaseCache.length === 0 ? 1 : (par2BaseCache._lastP + 1);
            while (p % 3 === 0 || p % 5 === 0 || p % 17 === 0 || p % 257 === 0) {
                p++;
            }
            par2BaseCache._lastP = p;
            par2BaseCache.push(gfExp[p % 65535]);
        }
        return par2BaseCache[sliceIndex];
    }

    /**
     * Multiply srcBytes (as Uint16LE words) by factor in GF(2^16) and XOR into dstBytes.
     */
    function gfMulAddBytes(dstBytes, srcBytes, factor) {
        if (factor === 0) {
            return;
        }
        var len = dstBytes.byteLength;
        var len16 = len >>> 1;
        // Fast path when both buffers are 2-byte aligned
        if ((dstBytes.byteOffset & 1) === 0 && (srcBytes.byteOffset & 1) === 0) {
            var dst16 = new Uint16Array(dstBytes.buffer, dstBytes.byteOffset, len16);
            var src16 = new Uint16Array(srcBytes.buffer, srcBytes.byteOffset, len16);
            if (factor === 1) {
                for (var k = 0; k < len16; k++) {
                    dst16[k] ^= src16[k];
                }
                return;
            }
            var logF = gfLog[factor];
            var tblLow = new Uint16Array(256);
            var tblHigh = new Uint16Array(256);
            for (var b = 1; b < 256; b++) {
                tblLow[b] = gfExp[logF + gfLog[b]];
                tblHigh[b] = gfExp[logF + gfLog[b << 8]];
            }
            for (var i = 0; i < len16; i++) {
                var v = src16[i];
                if (v !== 0) {
                    dst16[i] ^= tblLow[v & 0xff] ^ tblHigh[v >>> 8];
                }
            }
            return;
        }

        // Unaligned fallback
        var logFactor = gfLog[factor];
        for (var j = 0; j < len; j += 2) {
            var word = srcBytes[j] | (srcBytes[j + 1] << 8);
            if (word !== 0) {
                var prod = factor === 1 ? word : gfExp[logFactor + gfLog[word]];
                dstBytes[j] ^= prod & 0xff;
                dstBytes[j + 1] ^= prod >>> 8;
            }
        }
    }

    // =========================================================================
    // 3. PAR 2.0 Binary Packet Reader & Writer Helpers
    // =========================================================================
    function readUInt32LE(buf, offset) {
        return (
            (buf[offset]) |
            (buf[offset + 1] << 8) |
            (buf[offset + 2] << 16) |
            (buf[offset + 3] * 0x1000000)
        ) >>> 0;
    }

    function readUInt64LE(buf, offset) {
        var lo = readUInt32LE(buf, offset);
        var hi = readUInt32LE(buf, offset + 4);
        return hi * 0x100000000 + lo;
    }

    function writeUInt32LE(buf, offset, val) {
        var v = val >>> 0;
        buf[offset] = v & 0xff;
        buf[offset + 1] = (v >>> 8) & 0xff;
        buf[offset + 2] = (v >>> 16) & 0xff;
        buf[offset + 3] = (v >>> 24) & 0xff;
    }

    function writeUInt64LE(buf, offset, val) {
        var lo = val >>> 0;
        var hi = Math.floor(val / 0x100000000) >>> 0;
        writeUInt32LE(buf, offset, lo);
        writeUInt32LE(buf, offset + 4, hi);
    }

    function readAsciiTrimNull(buf, start, end) {
        var actualEnd = end;
        while (actualEnd > start && buf[actualEnd - 1] === 0) {
            actualEnd--;
        }
        var s = '';
        for (var i = start; i < actualEnd; i++) {
            s += String.fromCharCode(buf[i]);
        }
        return s;
    }

    function isPar2Magic(buf, offset) {
        return (
            offset + 8 <= buf.length &&
            buf[offset] === 0x50 &&     // 'P'
            buf[offset + 1] === 0x41 && // 'A'
            buf[offset + 2] === 0x52 && // 'R'
            buf[offset + 3] === 0x32 && // '2'
            buf[offset + 4] === 0x00 && // '\0'
            buf[offset + 5] === 0x50 && // 'P'
            buf[offset + 6] === 0x4b && // 'K'
            buf[offset + 7] === 0x54    // 'T'
        );
    }

    /**
     * Parse all valid PAR 2.0 packets from a Uint8Array buffer.
     * Supports optional sourceFilename so recovery slice data can either be kept or read from disk on demand.
     */
    function parsePar2Packets(buf, options) {
        var opts = options || {};
        var verifyPacketHash = opts.verifyPacketHash !== false;
        var keepRecoveryData = opts.keepRecoveryData !== false;
        var sourceFilename = opts.sourceFilename || null;

        var result = {
            recoverySetId: null,
            sliceSize: 0,
            recoveryFileIds: [],
            fileDescriptions: Object.create(null),
            ifscByFileId: Object.create(null),
            recoverySlices: Object.create(null),
            validPackets: 0,
            corruptPackets: 0
        };

        var pos = 0;
        var len = buf.length;

        while (pos + 64 <= len) {
            if (!isPar2Magic(buf, pos)) {
                pos++;
                continue;
            }

            var pktLen = readUInt64LE(buf, pos + 8);
            if (pktLen < 64 || (pktLen % 4) !== 0 || pos + pktLen > len) {
                result.corruptPackets++;
                pos += 8;
                continue;
            }

            if (verifyPacketHash) {
                var expectedHash = buf.subarray(pos + 16, pos + 32);
                var computedHash = md5(buf, pos + 32, pktLen - 32);
                if (!bytesEqual(expectedHash, computedHash)) {
                    result.corruptPackets++;
                    pos += 8;
                    continue;
                }
            }

            var setIdHex = bytesToHex(buf.subarray(pos + 32, pos + 48));
            if (!result.recoverySetId) {
                result.recoverySetId = setIdHex;
            }

            var pktType = readAsciiTrimNull(buf, pos + 48, pos + 64);
            var bodyStart = pos + 64;
            var bodyEnd = pos + pktLen;
            var bodyLen = bodyEnd - bodyStart;

            if (pktType === 'PAR 2.0\x00Main' || pktType.indexOf('Main') !== -1) {
                // Verify recovery_set_id is MD5 of Main body
                if (bodyLen >= 12) {
                    result.sliceSize = readUInt64LE(buf, bodyStart);
                    var recCount = readUInt32LE(buf, bodyStart + 8);
                    var ids = [];
                    var idOffset = bodyStart + 12;
                    for (var r = 0; r < recCount && idOffset + 16 <= bodyEnd; r++) {
                        ids.push(bytesToHex(buf.subarray(idOffset, idOffset + 16)));
                        idOffset += 16;
                    }
                    result.recoveryFileIds = ids;
                }
            } else if (pktType.indexOf('FileDesc') !== -1) {
                if (bodyLen >= 56) {
                    var fileIdHex = bytesToHex(buf.subarray(bodyStart, bodyStart + 16));
                    var hashFullHex = bytesToHex(buf.subarray(bodyStart + 16, bodyStart + 32));
                    var hash16kHex = bytesToHex(buf.subarray(bodyStart + 32, bodyStart + 48));
                    var fileLength = readUInt64LE(buf, bodyStart + 48);
                    var rawNameBytes = buf.subarray(bodyStart + 56, bodyEnd);
                    var nameEnd = rawNameBytes.length;
                    while (nameEnd > 0 && rawNameBytes[nameEnd - 1] === 0) {
                        nameEnd--;
                    }
                    var filename = '';
                    if (typeof TextDecoder !== 'undefined') {
                        filename = new TextDecoder('utf-8').decode(rawNameBytes.subarray(0, nameEnd));
                    } else {
                        for (var c = 0; c < nameEnd; c++) {
                            filename += String.fromCharCode(rawNameBytes[c]);
                        }
                    }
                    result.fileDescriptions[fileIdHex] = {
                        fileId: fileIdHex,
                        hashFull: hashFullHex,
                        hash16k: hash16kHex,
                        fileLength: fileLength,
                        filename: filename
                    };
                }
            } else if (pktType.indexOf('IFSC') !== -1) {
                if (bodyLen >= 16) {
                    var ifscFileId = bytesToHex(buf.subarray(bodyStart, bodyStart + 16));
                    var slices = [];
                    var sOff = bodyStart + 16;
                    while (sOff + 20 <= bodyEnd) {
                        slices.push({
                            md5: bytesToHex(buf.subarray(sOff, sOff + 16)),
                            crc32: readUInt32LE(buf, sOff + 16)
                        });
                        sOff += 20;
                    }
                    result.ifscByFileId[ifscFileId] = slices;
                }
            } else if (pktType.indexOf('RecvSlic') !== -1) {
                if (bodyLen >= 4) {
                    var exponent = readUInt32LE(buf, bodyStart);
                    var sliceDataLen = bodyLen - 4;
                    result.recoverySlices[exponent] = {
                        exponent: exponent,
                        sourceFilename: sourceFilename,
                        dataOffset: bodyStart + 4,
                        dataLength: sliceDataLen,
                        data: keepRecoveryData ? buf.slice(bodyStart + 4, bodyEnd) : null
                    };
                }
            }

            result.validPackets++;
            pos += pktLen;
        }

        return result;
    }

    /**
     * Merge multiple parsed PAR2 packet sets into a single unified recovery set.
     */
    function mergePar2Sets(sets) {
        var merged = {
            recoverySetId: null,
            sliceSize: 0,
            recoveryFileIds: [],
            fileDescriptions: Object.create(null),
            ifscByFileId: Object.create(null),
            recoverySlices: Object.create(null),
            validPackets: 0,
            corruptPackets: 0
        };

        for (var i = 0; i < sets.length; i++) {
            var s = sets[i];
            if (!s) {
                continue;
            }
            if (s.recoverySetId && !merged.recoverySetId) {
                merged.recoverySetId = s.recoverySetId;
            }
            if (s.sliceSize > 0 && merged.sliceSize === 0) {
                merged.sliceSize = s.sliceSize;
            }
            if (s.recoveryFileIds && s.recoveryFileIds.length > 0 && merged.recoveryFileIds.length === 0) {
                merged.recoveryFileIds = s.recoveryFileIds.slice();
            }
            var fIds = Object.keys(s.fileDescriptions);
            for (var f = 0; f < fIds.length; f++) {
                merged.fileDescriptions[fIds[f]] = s.fileDescriptions[fIds[f]];
            }
            var cIds = Object.keys(s.ifscByFileId);
            for (var c = 0; c < cIds.length; c++) {
                merged.ifscByFileId[cIds[c]] = s.ifscByFileId[cIds[c]];
            }
            var exps = Object.keys(s.recoverySlices);
            for (var e = 0; e < exps.length; e++) {
                var expNum = parseInt(exps[e], 10);
                var existing = merged.recoverySlices[expNum];
                var incoming = s.recoverySlices[expNum];
                if (!existing || (!existing.data && incoming.data)) {
                    merged.recoverySlices[expNum] = incoming;
                }
            }
            merged.validPackets += s.validPackets;
            merged.corruptPackets += s.corruptPackets;
        }

        return merged;
    }

    // =========================================================================
    // 4. Disk-Backed Target File Verification & Obfuscated Filename Resolution
    // =========================================================================
    /**
     * Verify all recovery set files using a disk-backed fileProvider.
     *
     * fileProvider interface (all sync in Worker/Node):
     *   exists(filename) -> boolean
     *   getSize(filename) -> number
     *   read(filename, uint8View, offset) -> bytesRead
     *   write(filename, uint8View, offset) -> bytesWritten
     *   truncate(filename, size) -> void
     *   listFiles() -> string[] (optional, for obfuscated filename matching by hash_16k)
     *   rename(oldName, newName) -> void (optional)
     */
    function verifyFiles(par2Set, fileProvider, onProgress) {
        if (!par2Set || !par2Set.sliceSize || par2Set.recoveryFileIds.length === 0) {
            throw new Error('Invalid or incomplete PAR2 Main packet metadata');
        }

        var sliceSize = par2Set.sliceSize;
        var globalSlices = [];
        var filesStatus = [];
        var damagedSliceCount = 0;

        // Build map of 16k hashes of unknown/candidate files if any target file is missing
        var candidate16kMap = null;
        function ensureCandidate16kMap() {
            if (candidate16kMap !== null) {
                return;
            }
            candidate16kMap = Object.create(null);
            if (typeof fileProvider.listFiles !== 'function') {
                return;
            }
            var knownNames = Object.create(null);
            for (var k = 0; k < par2Set.recoveryFileIds.length; k++) {
                var fd = par2Set.fileDescriptions[par2Set.recoveryFileIds[k]];
                if (fd) {
                    knownNames[fd.filename.toLowerCase()] = true;
                }
            }
            var allDiskFiles = fileProvider.listFiles() || [];
            var buf16k = new Uint8Array(16384);
            for (var d = 0; d < allDiskFiles.length; d++) {
                var diskName = allDiskFiles[d];
                if (/\.par2$/i.test(diskName) || knownNames[diskName.toLowerCase()]) {
                    continue;
                }
                if (fileProvider.exists(diskName)) {
                    var sz = fileProvider.getSize(diskName);
                    var toRead = Math.min(16384, sz);
                    var n = toRead > 0 ? fileProvider.read(diskName, buf16k.subarray(0, toRead), 0) : 0;
                    var h16 = md5Hex(buf16k, 0, n);
                    candidate16kMap[h16] = diskName;
                }
            }
        }

        var readChunkSize = Math.min(sliceSize, 262144);
        var chunkBuf = new Uint8Array(readChunkSize);
        var zeroBuf = new Uint8Array(Math.min(sliceSize, 65536));

        for (var fIdx = 0; fIdx < par2Set.recoveryFileIds.length; fIdx++) {
            var fileId = par2Set.recoveryFileIds[fIdx];
            var desc = par2Set.fileDescriptions[fileId];
            if (!desc) {
                throw new Error('PAR2 set is missing FileDescription packet for fileId ' + fileId);
            }
            var ifsc = par2Set.ifscByFileId[fileId] || [];
            var numSlices = Math.ceil(desc.fileLength / sliceSize) || (desc.fileLength === 0 ? 0 : 1);

            // Check if file exists; if not, check if an obfuscated file matches hash_16k
            if (!fileProvider.exists(desc.filename)) {
                ensureCandidate16kMap();
                var matchedDiskName = candidate16kMap[desc.hash16k];
                if (matchedDiskName && typeof fileProvider.rename === 'function') {
                    fileProvider.rename(matchedDiskName, desc.filename);
                }
            }

            var exists = fileProvider.exists(desc.filename);
            var diskSize = exists ? fileProvider.getSize(desc.filename) : 0;
            var fileFullMd5 = new Md5Hasher();
            var fileDamagedSlices = 0;

            for (var s = 0; s < numSlices; s++) {
                var globalIndex = globalSlices.length;
                var sliceStart = s * sliceSize;
                var expectedBytesInFile = Math.min(sliceSize, Math.max(0, desc.fileLength - sliceStart));
                var expectedChecksum = ifsc[s] || null;
                var isSliceValid = false;

                if (exists && sliceStart < diskSize) {
                    var availableInFile = Math.min(expectedBytesInFile, Math.max(0, diskSize - sliceStart));
                    var sliceMd5 = new Md5Hasher();
                    var sliceCrc = 0;
                    var offsetInSlice = 0;

                    while (offsetInSlice < availableInFile) {
                        var step = Math.min(readChunkSize, availableInFile - offsetInSlice);
                        var view = chunkBuf.subarray(0, step);
                        var got = fileProvider.read(desc.filename, view, sliceStart + offsetInSlice);
                        if (got < step) {
                            view.fill(0, got, step);
                        }
                        sliceMd5.update(view, 0, step);
                        fileFullMd5.update(view, 0, step);
                        sliceCrc = crc32Update(sliceCrc, view, 0, step);
                        offsetInSlice += step;
                    }

                    // Pad up to sliceSize with zeros for PAR2 slice checksum calculation
                    var padRemaining = sliceSize - availableInFile;
                    while (padRemaining > 0) {
                        var zStep = Math.min(zeroBuf.length, padRemaining);
                        sliceMd5.update(zeroBuf, 0, zStep);
                        sliceCrc = crc32Update(sliceCrc, zeroBuf, 0, zStep);
                        padRemaining -= zStep;
                    }

                    var computedSliceMd5 = sliceMd5.digestHex();
                    if (expectedChecksum) {
                        isSliceValid = (
                            sliceCrc === expectedChecksum.crc32 &&
                            computedSliceMd5 === expectedChecksum.md5 &&
                            availableInFile === expectedBytesInFile
                        );
                    } else if (availableInFile === expectedBytesInFile) {
                        isSliceValid = true;
                    }
                }

                if (!isSliceValid) {
                    damagedSliceCount++;
                    fileDamagedSlices++;
                }

                globalSlices.push({
                    globalIndex: globalIndex,
                    fileId: fileId,
                    filename: desc.filename,
                    fileLength: desc.fileLength,
                    sliceIndexInFile: s,
                    fileOffset: sliceStart,
                    validBytesLength: expectedBytesInFile,
                    expectedMd5: expectedChecksum ? expectedChecksum.md5 : null,
                    expectedCrc32: expectedChecksum ? expectedChecksum.crc32 : null,
                    valid: isSliceValid
                });
            }

            var computedFullMd5 = exists ? fileFullMd5.digestHex() : null;
            var fileCompleteAndValid = (
                exists &&
                diskSize === desc.fileLength &&
                fileDamagedSlices === 0 &&
                computedFullMd5 === desc.hashFull
            );

            // Edge case: if IFSC was missing from index, mark slices damaged if full MD5 failed
            if (!fileCompleteAndValid && fileDamagedSlices === 0 && numSlices > 0) {
                for (var g = globalSlices.length - numSlices; g < globalSlices.length; g++) {
                    globalSlices[g].valid = false;
                    damagedSliceCount++;
                    fileDamagedSlices++;
                }
            }

            filesStatus.push({
                fileId: fileId,
                filename: desc.filename,
                expectedLength: desc.fileLength,
                diskLength: diskSize,
                exists: exists,
                totalSlices: numSlices,
                damagedSlices: fileDamagedSlices,
                valid: fileCompleteAndValid
            });

            if (typeof onProgress === 'function') {
                onProgress({
                    phase: 'verifying',
                    completedFiles: fIdx + 1,
                    totalFiles: par2Set.recoveryFileIds.length,
                    damagedSlices: damagedSliceCount
                });
            }
        }

        var availableExponents = Object.keys(par2Set.recoverySlices).map(function (k) {
            return parseInt(k, 10);
        }).sort(function (a, b) {
            return a - b;
        });

        return {
            allValid: damagedSliceCount === 0,
            damagedSliceCount: damagedSliceCount,
            availableRecoveryCount: availableExponents.length,
            canRepair: availableExponents.length >= damagedSliceCount,
            filesStatus: filesStatus,
            globalSlices: globalSlices
        };
    }

    // =========================================================================
    // 5. Striped Disk-Backed Reed-Solomon Repair in GF(2^16)
    // =========================================================================
    function invertRepairMatrix(damagedSliceIndices, exponents) {
        var D = damagedSliceIndices.length;
        var mat = new Array(D);
        for (var r = 0; r < D; r++) {
            var row = new Uint16Array(D * 2);
            var exp = exponents[r];
            for (var c = 0; c < D; c++) {
                row[c] = gfPow(getPar2Base(damagedSliceIndices[c]), exp);
            }
            row[D + r] = 1;
            mat[r] = row;
        }

        for (var col = 0; col < D; col++) {
            var pivot = col;
            while (pivot < D && mat[pivot][col] === 0) {
                pivot++;
            }
            if (pivot === D) {
                throw new Error('PAR2 Reed-Solomon matrix is singular and cannot be inverted');
            }
            if (pivot !== col) {
                var tmp = mat[col];
                mat[col] = mat[pivot];
                mat[pivot] = tmp;
            }
            var invPivot = gfDiv(1, mat[col][col]);
            for (var j = col; j < D * 2; j++) {
                mat[col][j] = gfMul(mat[col][j], invPivot);
            }
            for (var rowIdx = 0; rowIdx < D; rowIdx++) {
                if (rowIdx !== col && mat[rowIdx][col] !== 0) {
                    var factor = mat[rowIdx][col];
                    for (var k = col; k < D * 2; k++) {
                        mat[rowIdx][k] ^= gfMul(factor, mat[col][k]);
                    }
                }
            }
        }

        var inv = new Array(D);
        for (var i = 0; i < D; i++) {
            inv[i] = mat[i].subarray(D, D * 2);
        }
        return inv;
    }

    /**
     * Repair damaged/missing slices using striped disk-backed GF(2^16) Reed-Solomon reconstruction.
     * Processes slices in horizontal stripes (default 256 KB) to bound memory usage regardless of file size.
     */
    function repairFiles(par2Set, verification, fileProvider, options) {
        var opts = options || {};
        var onProgress = opts.onProgress || null;
        var stripeSize = opts.stripeSize || 262144; // 256 KB default stripe (must be even)
        if (stripeSize & 1) {
            stripeSize++;
        }

        if (!verification) {
            verification = verifyFiles(par2Set, fileProvider, onProgress);
        }
        if (verification.allValid) {
            return {
                repaired: false,
                repairedSliceCount: 0,
                verification: verification
            };
        }

        var damagedSlices = [];
        var intactSlices = [];
        for (var i = 0; i < verification.globalSlices.length; i++) {
            var sl = verification.globalSlices[i];
            if (sl.valid) {
                intactSlices.push(sl);
            } else {
                damagedSlices.push(sl);
            }
        }

        var D = damagedSlices.length;
        var availableExponents = Object.keys(par2Set.recoverySlices).map(function (k) {
            return parseInt(k, 10);
        }).sort(function (a, b) {
            return a - b;
        });

        if (availableExponents.length < D) {
            throw new Error(
                'Insufficient PAR2 recovery blocks: ' + D + ' damaged/missing slice(s) detected, but only ' +
                availableExponents.length + ' recovery block(s) available'
            );
        }

        var selectedExponents = availableExponents.slice(0, D);
        var damagedIndices = damagedSlices.map(function (s) {
            return s.globalIndex;
        });

        // 1. Invert D x D Reed-Solomon repair matrix in GF(2^16)
        var invMatrix = invertRepairMatrix(damagedIndices, selectedExponents);

        var sliceSize = par2Set.sliceSize;
        var numStripes = Math.ceil(sliceSize / stripeSize);

        // Precompute factor table: intactFactors[r][intactIdx] = Base(k) ^ exp_r
        var intactFactors = new Array(D);
        for (var r = 0; r < D; r++) {
            var rowFactors = new Uint16Array(intactSlices.length);
            var exp = selectedExponents[r];
            for (var m = 0; m < intactSlices.length; m++) {
                rowFactors[m] = gfPow(getPar2Base(intactSlices[m].globalIndex), exp);
            }
            intactFactors[r] = rowFactors;
        }

        // Reusable stripe buffers (bounded memory!)
        var srcStripe = new Uint8Array(stripeSize);
        var outStripe = new Uint8Array(stripeSize);
        var rhsStripes = new Array(D);
        for (var d = 0; d < D; d++) {
            rhsStripes[d] = new Uint8Array(stripeSize);
        }

        // 2. Process sliceSize in horizontal stripes of stripeSize bytes
        for (var st = 0; st < numStripes; st++) {
            var stripeOffset = st * stripeSize;
            var currentStripeLen = Math.min(stripeSize, sliceSize - stripeOffset);

            // Load initial recovery slice stripes for this stripeOffset
            for (var rIdx = 0; rIdx < D; rIdx++) {
                var recSlice = par2Set.recoverySlices[selectedExponents[rIdx]];
                var rhsView = rhsStripes[rIdx].subarray(0, currentStripeLen);
                if (recSlice.data) {
                    rhsView.set(recSlice.data.subarray(stripeOffset, stripeOffset + currentStripeLen));
                } else if (recSlice.sourceFilename && fileProvider.exists(recSlice.sourceFilename)) {
                    fileProvider.read(recSlice.sourceFilename, rhsView, recSlice.dataOffset + stripeOffset);
                } else {
                    throw new Error('Recovery slice data unavailable for exponent ' + selectedExponents[rIdx]);
                }
            }

            // Subtract (XOR) contributions of all intact slices for this stripe
            var srcView = srcStripe.subarray(0, currentStripeLen);
            for (var iIdx = 0; iIdx < intactSlices.length; iIdx++) {
                var intact = intactSlices[iIdx];
                srcView.fill(0);
                if (stripeOffset < intact.validBytesLength) {
                    var readLen = Math.min(currentStripeLen, intact.validBytesLength - stripeOffset);
                    fileProvider.read(
                        intact.filename,
                        srcView.subarray(0, readLen),
                        intact.fileOffset + stripeOffset
                    );
                }
                for (var rRow = 0; rRow < D; rRow++) {
                    gfMulAddBytes(rhsStripes[rRow].subarray(0, currentStripeLen), srcView, intactFactors[rRow][iIdx]);
                }
            }

            // Reconstruct each damaged slice's stripe and write directly to disk
            var outView = outStripe.subarray(0, currentStripeLen);
            for (var dIdx = 0; dIdx < D; dIdx++) {
                var damaged = damagedSlices[dIdx];
                outView.fill(0);
                var invRow = invMatrix[dIdx];
                for (var rCol = 0; rCol < D; rCol++) {
                    gfMulAddBytes(outView, rhsStripes[rCol].subarray(0, currentStripeLen), invRow[rCol]);
                }
                if (stripeOffset < damaged.validBytesLength) {
                    var writeLen = Math.min(currentStripeLen, damaged.validBytesLength - stripeOffset);
                    fileProvider.write(
                        damaged.filename,
                        outView.subarray(0, writeLen),
                        damaged.fileOffset + stripeOffset
                    );
                }
            }

            if (typeof onProgress === 'function') {
                onProgress({
                    phase: 'repairing',
                    completedStripes: st + 1,
                    totalStripes: numStripes,
                    repairedSlices: D
                });
            }
        }

        // 3. Ensure repaired files are truncated to their exact FileDesc lengths
        for (var f = 0; f < par2Set.recoveryFileIds.length; f++) {
            var fid = par2Set.recoveryFileIds[f];
            var fDesc = par2Set.fileDescriptions[fid];
            if (fDesc && fileProvider.exists(fDesc.filename) && typeof fileProvider.truncate === 'function') {
                if (fileProvider.getSize(fDesc.filename) !== fDesc.fileLength) {
                    fileProvider.truncate(fDesc.filename, fDesc.fileLength);
                }
            }
        }

        // 4. Re-verify all files after repair
        var postVerify = verifyFiles(par2Set, fileProvider, onProgress);
        if (!postVerify.allValid) {
            throw new Error('Post-repair PAR2 verification failed: ' + postVerify.damagedSliceCount + ' slice(s) still invalid');
        }

        return {
            repaired: true,
            repairedSliceCount: D,
            verification: postVerify
        };
    }

    // =========================================================================
    // 6. PAR 2.0 File & Recovery Volume Generator (for Fixtures & Tests)
    // =========================================================================
    function buildPar2Packet(typeStr16, recoverySetIdBytes, bodyBytes) {
        var paddedBodyLen = Math.ceil(bodyBytes.length / 4) * 4;
        var totalLen = 64 + paddedBodyLen;
        var pkt = new Uint8Array(totalLen);
        // Magic "PAR2\0PKT"
        pkt.set([0x50, 0x41, 0x52, 0x32, 0x00, 0x50, 0x4b, 0x54], 0);
        writeUInt64LE(pkt, 8, totalLen);
        pkt.set(recoverySetIdBytes, 32);
        for (var i = 0; i < 16 && i < typeStr16.length; i++) {
            pkt[48 + i] = typeStr16.charCodeAt(i);
        }
        pkt.set(bodyBytes, 64);
        var pktHash = md5(pkt, 32, totalLen - 32);
        pkt.set(pktHash, 16);
        return pkt;
    }

    /**
     * Create spec-compliant PAR2 index + recovery volume buffers for an array of files.
     * @param {Array<{filename: string, data: Uint8Array}>} files
     * @param {number} sliceSize Multiple of 4
     * @param {number} recoveryCount Number of recovery blocks to generate
     */
    function createPar2Volumes(files, sliceSize, recoveryCount) {
        if ((sliceSize % 4) !== 0 || sliceSize <= 0) {
            throw new Error('PAR2 sliceSize must be a positive multiple of 4');
        }

        var fileEntries = files.map(function (f) {
            var nameBytes = new Uint8Array(f.filename.length);
            for (var i = 0; i < f.filename.length; i++) {
                nameBytes[i] = f.filename.charCodeAt(i) & 0xff;
            }
            var hashFull = md5(f.data);
            var hash16k = md5(f.data, 0, Math.min(16384, f.data.length));
            var idPreimage = new Uint8Array(16 + 8 + nameBytes.length);
            idPreimage.set(hash16k, 0);
            writeUInt64LE(idPreimage, 16, f.data.length);
            idPreimage.set(nameBytes, 24);
            var fileId = md5(idPreimage);
            return {
                filename: f.filename,
                nameBytes: nameBytes,
                data: f.data,
                hashFull: hashFull,
                hash16k: hash16k,
                fileId: fileId,
                fileIdHex: bytesToHex(fileId)
            };
        });

        // Sort by fileId ascending (128-bit LE as per PAR 2.0 spec)
        fileEntries.sort(function (a, b) {
            return compareFileIdsLE(a.fileIdHex, b.fileIdHex);
        });

        // Build Main packet body
        var mainBody = new Uint8Array(12 + 16 * fileEntries.length);
        writeUInt64LE(mainBody, 0, sliceSize);
        writeUInt32LE(mainBody, 8, fileEntries.length);
        for (var i = 0; i < fileEntries.length; i++) {
            mainBody.set(fileEntries[i].fileId, 12 + i * 16);
        }
        var recoverySetId = md5(mainBody);
        var mainPkt = buildPar2Packet('PAR 2.0\x00Main\x00\x00\x00\x00', recoverySetId, mainBody);

        var metaPackets = [mainPkt];
        var allInputSlices = [];

        for (var fIdx = 0; fIdx < fileEntries.length; fIdx++) {
            var fe = fileEntries[fIdx];
            var paddedNameLen = Math.ceil(fe.nameBytes.length / 4) * 4;
            var fdBody = new Uint8Array(56 + paddedNameLen);
            fdBody.set(fe.fileId, 0);
            fdBody.set(fe.hashFull, 16);
            fdBody.set(fe.hash16k, 32);
            writeUInt64LE(fdBody, 48, fe.data.length);
            fdBody.set(fe.nameBytes, 56);
            metaPackets.push(buildPar2Packet('PAR 2.0\x00FileDesc', recoverySetId, fdBody));

            var numSlices = Math.ceil(fe.data.length / sliceSize) || (fe.data.length === 0 ? 0 : 1);
            var ifscBody = new Uint8Array(16 + numSlices * 20);
            ifscBody.set(fe.fileId, 0);

            for (var s = 0; s < numSlices; s++) {
                var sliceBuf = new Uint8Array(sliceSize);
                var start = s * sliceSize;
                var end = Math.min(start + sliceSize, fe.data.length);
                sliceBuf.set(fe.data.subarray(start, end), 0);
                var sMd5 = md5(sliceBuf);
                var sCrc = crc32(sliceBuf);
                ifscBody.set(sMd5, 16 + s * 20);
                writeUInt32LE(ifscBody, 16 + s * 20 + 16, sCrc);
                allInputSlices.push(sliceBuf);
            }
            metaPackets.push(buildPar2Packet('PAR 2.0\x00IFSC\x00\x00\x00\x00', recoverySetId, ifscBody));
        }

        function concatUint8Arrays(arrs) {
            var total = 0;
            for (var a = 0; a < arrs.length; a++) {
                total += arrs[a].length;
            }
            var res = new Uint8Array(total);
            var off = 0;
            for (var b = 0; b < arrs.length; b++) {
                res.set(arrs[b], off);
                off += arrs[b].length;
            }
            return res;
        }

        var indexPar2 = concatUint8Arrays(metaPackets);
        var recoveryPackets = [];

        for (var exp = 0; exp < recoveryCount; exp++) {
            var recData = new Uint8Array(sliceSize);
            for (var k = 0; k < allInputSlices.length; k++) {
                var factor = gfPow(getPar2Base(k), exp);
                gfMulAddBytes(recData, allInputSlices[k], factor);
            }
            var recBody = new Uint8Array(4 + sliceSize);
            writeUInt32LE(recBody, 0, exp);
            recBody.set(recData, 4);
            recoveryPackets.push(buildPar2Packet('PAR 2.0\x00RecvSlic', recoverySetId, recBody));
        }

        var volPar2 = concatUint8Arrays(metaPackets.concat(recoveryPackets));
        return {
            indexPar2: indexPar2,
            volumePar2: volPar2,
            recoveryPackets: recoveryPackets,
            metaPackets: metaPackets
        };
    }

    return {
        Md5Hasher: Md5Hasher,
        md5: md5,
        md5Hex: md5Hex,
        bytesToHex: bytesToHex,
        gfMul: gfMul,
        gfDiv: gfDiv,
        gfPow: gfPow,
        getPar2Base: getPar2Base,
        gfMulAddBytes: gfMulAddBytes,
        parsePar2Packets: parsePar2Packets,
        mergePar2Sets: mergePar2Sets,
        verifyFiles: verifyFiles,
        repairFiles: repairFiles,
        createPar2Volumes: createPar2Volumes
    };
}));
