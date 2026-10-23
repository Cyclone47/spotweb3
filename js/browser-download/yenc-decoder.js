/**
 * Spotweb Browser Download Engine - High-Speed Zero-Copy yEnc Decoder & CRC32 Verifier
 * Runs in Browser Main Thread, Dedicated Web Worker, and Node.js.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        var exp = factory();
        root.SpotwebYencDecoder = exp;
        root.SpotwebYenc = exp;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var CRC32_TABLE = new Uint32Array(256);
    (function initCrcTable() {
        for (var i = 0; i < 256; i++) {
            var c = i;
            for (var k = 0; k < 8; k++) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            CRC32_TABLE[i] = c >>> 0;
        }
    }());

    function crc32Update(crc, buf, offset, length) {
        var c = (crc ^ 0xffffffff) >>> 0;
        var start = offset || 0;
        var end = length !== undefined ? (start + length) : buf.length;
        for (var i = start; i < end; i++) {
            c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
        }
        return (c ^ 0xffffffff) >>> 0;
    }

    function crc32(buf, offset, length) {
        return crc32Update(0, buf, offset, length);
    }

    // GF(2) matrix helpers for crc32Combine
    function gf2MatrixTimes(mat, vec) {
        var sum = 0;
        var idx = 0;
        var v = vec >>> 0;
        while (v !== 0) {
            if (v & 1) {
                sum = (sum ^ mat[idx]) >>> 0;
            }
            v >>>= 1;
            idx++;
        }
        return sum >>> 0;
    }

    function gf2MatrixSquare(square, mat) {
        for (var n = 0; n < 32; n++) {
            square[n] = gf2MatrixTimes(mat, mat[n]);
        }
    }

    /**
     * Combine two CRC32 values: CRC(A || B) given CRC(A), CRC(B), and byte length of B.
     */
    function crc32Combine(crc1, crc2, len2) {
        if (len2 <= 0) {
            return crc1 >>> 0;
        }
        var even = new Uint32Array(32);
        var odd = new Uint32Array(32);

        odd[0] = 0xedb88320 >>> 0;
        var row = 1;
        for (var n = 1; n < 32; n++) {
            odd[n] = row >>> 0;
            row = (row << 1) >>> 0;
        }

        gf2MatrixSquare(even, odd);
        gf2MatrixSquare(odd, even);

        var c1 = crc1 >>> 0;
        var c2 = crc2 >>> 0;
        var length = Number(len2);

        do {
            gf2MatrixSquare(even, odd);
            if (length & 1) {
                c1 = gf2MatrixTimes(even, c1);
            }
            length = Math.floor(length / 2);
            if (length === 0) {
                break;
            }
            gf2MatrixSquare(odd, even);
            if (length & 1) {
                c1 = gf2MatrixTimes(odd, c1);
            }
            length = Math.floor(length / 2);
        } while (length !== 0);

        return (c1 ^ c2) >>> 0;
    }

    function parseHeaderLineParams(lineStr) {
        var params = {};
        var nameIdx = lineStr.indexOf(' name=');
        var headPart = lineStr;
        if (nameIdx !== -1) {
            params.name = lineStr.slice(nameIdx + 6).replace(/[\r\n]+$/, '');
            headPart = lineStr.slice(0, nameIdx);
        }
        var tokens = headPart.split(/\s+/);
        for (var i = 1; i < tokens.length; i++) {
            var eq = tokens[i].indexOf('=');
            if (eq > 0) {
                var k = tokens[i].slice(0, eq).toLowerCase();
                var v = tokens[i].slice(eq + 1);
                params[k] = v;
            }
        }
        return params;
    }

    function parseHexCrc(hexStr) {
        if (!hexStr || typeof hexStr !== 'string') {
            return null;
        }
        // Strip possible leading 0x or whitespace, take last 8 hex chars
        var cleaned = hexStr.trim().replace(/^0x/i, '');
        if (!/^[0-9a-fA-F]{1,8}$/.test(cleaned)) {
            return null;
        }
        return (parseInt(cleaned, 16) >>> 0);
    }

    function asciiSlice(bytes, start, end) {
        var chars = [];
        for (var i = start; i < end; i++) {
            chars.push(String.fromCharCode(bytes[i]));
        }
        return chars.join('');
    }

    /**
     * Decode a yEnc-encoded article body in a single pass with rolling CRC32 verification.
     *
     * @param {Uint8Array} rawBytes Raw article body bytes
     * @param {Object} [options]
     * @param {boolean} [options.dotUnstuff=true] Whether rawBytes still has NNTP dot-stuffing (".." at start of line)
     * @param {boolean} [options.strictCrc=true] Throw error if CRC32 or byte length mismatches
     * @returns {Object} { data: Uint8Array, offset: number, size: number, totalSize: number, part: number, crc32: number, fileCrc32: number|null, filename: string }
     */
    function decodeYencArticle(rawBytes, options) {
        var opts = options || {};
        var dotUnstuff = opts.dotUnstuff !== false;
        var strictCrc = opts.strictCrc !== false;

        if (!(rawBytes instanceof Uint8Array)) {
            throw new Error('decodeYencArticle requires a Uint8Array input');
        }

        var len = rawBytes.length;
        var pos = 0;
        var ybegin = null;
        var ypart = null;
        var yend = null;

        // 1. Locate =ybegin (and optional =ypart)
        while (pos < len) {
            var lineEnd = pos;
            while (lineEnd < len && rawBytes[lineEnd] !== 10) {
                lineEnd++;
            }
            var trimEnd = lineEnd;
            if (trimEnd > pos && rawBytes[trimEnd - 1] === 13) {
                trimEnd--;
            }
            var lineStart = pos;
            if (dotUnstuff && (trimEnd - lineStart >= 2) && rawBytes[lineStart] === 46 && rawBytes[lineStart + 1] === 46) {
                lineStart++;
            }
            // Check for "=y" (61, 121)
            if (trimEnd - lineStart >= 7 && rawBytes[lineStart] === 61 && rawBytes[lineStart + 1] === 121) {
                var headerLine = asciiSlice(rawBytes, lineStart, trimEnd);
                if (headerLine.indexOf('=ybegin ') === 0) {
                    ybegin = parseHeaderLineParams(headerLine);
                    pos = lineEnd + 1;
                    // Check if next line is =ypart
                    if (pos < len) {
                        var nextEnd = pos;
                        while (nextEnd < len && rawBytes[nextEnd] !== 10) {
                            nextEnd++;
                        }
                        var nextTrim = nextEnd;
                        if (nextTrim > pos && rawBytes[nextTrim - 1] === 13) {
                            nextTrim--;
                        }
                        var nextStart = pos;
                        if (dotUnstuff && (nextTrim - nextStart >= 2) && rawBytes[nextStart] === 46 && rawBytes[nextStart + 1] === 46) {
                            nextStart++;
                        }
                        if (nextTrim - nextStart >= 6 && rawBytes[nextStart] === 61 && rawBytes[nextStart + 1] === 121) {
                            var partLine = asciiSlice(rawBytes, nextStart, nextTrim);
                            if (partLine.indexOf('=ypart ') === 0) {
                                ypart = parseHeaderLineParams(partLine);
                                pos = nextEnd + 1;
                            }
                        }
                    }
                    break;
                }
            }
            pos = lineEnd + 1;
        }

        if (!ybegin) {
            throw new Error('Missing =ybegin header in article');
        }

        var totalSize = parseInt(ybegin.size || '0', 10);
        if (!Number.isFinite(totalSize) || totalSize < 0) {
            throw new Error('Invalid size in =ybegin header');
        }

        var partNum = ybegin.part !== undefined ? parseInt(ybegin.part, 10) : 1;
        var beginOffset = 0;
        var expectedPartSize = totalSize;

        if (ypart) {
            var pBegin = parseInt(ypart.begin || '0', 10);
            var pEnd = parseInt(ypart.end || '0', 10);
            if (!Number.isFinite(pBegin) || !Number.isFinite(pEnd) || pBegin < 1 || pEnd < pBegin) {
                throw new Error('Invalid =ypart range: begin=' + ypart.begin + ' end=' + ypart.end);
            }
            if (totalSize > 0 && pEnd > totalSize) {
                throw new Error('=ypart end offset (' + pEnd + ') exceeds total file size (' + totalSize + ')');
            }
            beginOffset = pBegin - 1;
            expectedPartSize = pEnd - pBegin + 1;
        } else if (ybegin.part !== undefined && parseInt(ybegin.total || '1', 10) > 1) {
            throw new Error('Multi-part yEnc article (part ' + ybegin.part + ') is missing =ypart header');
        }

        var outAlloc = expectedPartSize > 0 ? expectedPartSize : Math.min(len, totalSize || len);
        var outBuf = new Uint8Array(outAlloc);
        var outPos = 0;
        var crc = 0xffffffff >>> 0;
        var atLineStart = true;

        // 2. Decode yEnc body line-by-line until =yend
        while (pos < len) {
            // At start of line, check for "=yend " or dot-stuffing
            if (atLineStart) {
                var checkPos = pos;
                if (dotUnstuff && checkPos + 1 < len && rawBytes[checkPos] === 46 && rawBytes[checkPos + 1] === 46) {
                    pos++; // Skip stuffed dot
                    checkPos = pos;
                } else if (dotUnstuff && checkPos + 1 < len && rawBytes[checkPos] === 46 && (rawBytes[checkPos + 1] === 13 || rawBytes[checkPos + 1] === 10)) {
                    // NNTP end-of-article ".\r\n"
                    break;
                }

                // Check for "=yend " (61, 121, 101, 110, 100, 32)
                if (checkPos + 6 <= len &&
                    rawBytes[checkPos] === 61 &&
                    rawBytes[checkPos + 1] === 121 &&
                    rawBytes[checkPos + 2] === 101 &&
                    rawBytes[checkPos + 3] === 110 &&
                    rawBytes[checkPos + 4] === 100 &&
                    (rawBytes[checkPos + 5] === 32 || rawBytes[checkPos + 5] === 13 || rawBytes[checkPos + 5] === 10)) {
                    var endLineEnd = checkPos;
                    while (endLineEnd < len && rawBytes[endLineEnd] !== 10) {
                        endLineEnd++;
                    }
                    var endTrim = endLineEnd;
                    if (endTrim > checkPos && rawBytes[endTrim - 1] === 13) {
                        endTrim--;
                    }
                    var endLineStr = asciiSlice(rawBytes, checkPos, endTrim);
                    yend = parseHeaderLineParams(endLineStr);
                    break;
                }
                atLineStart = false;
            }

            var b = rawBytes[pos++];
            if (b === 10) {
                atLineStart = true;
                continue;
            }
            if (b === 13) {
                continue;
            }
            if (b === 61) { // '=' escape byte
                // Skip rare line wrap between '=' and escaped char if any
                while (pos < len && (rawBytes[pos] === 13 || rawBytes[pos] === 10)) {
                    pos++;
                }
                if (pos >= len) {
                    throw new Error('Truncated yEnc escape sequence at end of article');
                }
                b = (rawBytes[pos++] - 64 - 42) & 0xff;
            } else {
                b = (b - 42) & 0xff;
            }

            if (outPos >= outBuf.length) {
                var grown = new Uint8Array(Math.max(outBuf.length * 2, outPos + 4096));
                grown.set(outBuf);
                outBuf = grown;
            }
            outBuf[outPos++] = b;
            crc = CRC32_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
        }

        crc = (crc ^ 0xffffffff) >>> 0;

        if (!yend) {
            throw new Error('Missing =yend trailer in yEnc article');
        }

        var yendSize = parseInt(yend.size || '-1', 10);
        if (strictCrc) {
            if (yendSize !== outPos) {
                throw new Error('yEnc decoded size (' + outPos + ') does not match =yend size (' + yendSize + ')');
            }
            if (ypart && outPos !== expectedPartSize) {
                throw new Error('yEnc decoded size (' + outPos + ') does not match =ypart range (' + expectedPartSize + ')');
            }

            var expectedPartCrc = yend.pcrc32 !== undefined ? parseHexCrc(yend.pcrc32) : parseHexCrc(yend.crc32);
            if (expectedPartCrc === null) {
                throw new Error('Missing or malformed CRC32 in =yend trailer');
            }
            if (crc !== expectedPartCrc) {
                throw new Error(
                    'yEnc CRC32 mismatch on part ' + partNum + ': expected ' +
                    expectedPartCrc.toString(16).padStart(8, '0') + ', got ' +
                    crc.toString(16).padStart(8, '0')
                );
            }
        }

        var decodedView = outPos === outBuf.length ? outBuf : outBuf.subarray(0, outPos);
        var fullFileCrc = yend.crc32 !== undefined ? parseHexCrc(yend.crc32) : null;

        return {
            data: decodedView,
            offset: beginOffset,
            size: outPos,
            totalSize: totalSize,
            part: partNum,
            crc32: crc,
            fileCrc32: fullFileCrc,
            filename: ybegin.name || ''
        };
    }

    /**
     * Encode a binary chunk into a valid yEnc article (used by fixture generator and tests).
     *
     * @param {Uint8Array} chunkData Unencoded part bytes
     * @param {Object} meta { filename, totalSize, part, totalParts, offset, fileCrc32, dotStuff }
     * @returns {Uint8Array}
     */
    function encodeYencArticle(chunkData, meta) {
        var m = meta || {};
        var filename = m.filename || 'test.bin';
        var totalSize = m.totalSize !== undefined ? m.totalSize : chunkData.length;
        var part = m.part || 1;
        var totalParts = m.totalParts || 1;
        var offset = m.offset || 0;
        var dotStuff = m.dotStuff !== false;
        var lineLen = m.lineLength || 128;

        var partCrc = crc32(chunkData);
        var headerLines = [];
        if (totalParts > 1 || m.multipart) {
            headerLines.push('=ybegin part=' + part + ' total=' + totalParts + ' line=' + lineLen + ' size=' + totalSize + ' name=' + filename);
            headerLines.push('=ypart begin=' + (offset + 1) + ' end=' + (offset + chunkData.length));
        } else {
            headerLines.push('=ybegin line=' + lineLen + ' size=' + totalSize + ' name=' + filename);
        }

        var endLine = '=yend size=' + chunkData.length;
        if (totalParts > 1 || m.multipart) {
            endLine += ' part=' + part + ' pcrc32=' + partCrc.toString(16).padStart(8, '0');
            if (m.fileCrc32 !== undefined && m.fileCrc32 !== null) {
                endLine += ' crc32=' + (m.fileCrc32 >>> 0).toString(16).padStart(8, '0');
            }
        } else {
            endLine += ' crc32=' + partCrc.toString(16).padStart(8, '0');
        }

        var headerStr = headerLines.join('\r\n') + '\r\n';
        var footerStr = endLine + '\r\n';
        if (m.terminateDot) {
            footerStr += '.\r\n';
        }

        // Worst-case encoded size is ~2x chunkData.length + headers
        var maxBody = Math.ceil(chunkData.length * 2.1) + headerStr.length + footerStr.length + 256;
        var out = new Uint8Array(maxBody);
        var p = 0;

        for (var h = 0; h < headerStr.length; h++) {
            out[p++] = headerStr.charCodeAt(h);
        }

        var col = 0;
        for (var i = 0; i < chunkData.length; i++) {
            var v = (chunkData[i] + 42) & 0xff;
            var mustEscape = (v === 0 || v === 10 || v === 13 || v === 61 || (col === 0 && v === 46));
            if (mustEscape) {
                out[p++] = 61; // '='
                out[p++] = (v + 64) & 0xff;
                col += 2;
            } else {
                if (dotStuff && col === 0 && v === 46) {
                    out[p++] = 46;
                }
                out[p++] = v;
                col++;
            }
            if (col >= lineLen && i + 1 < chunkData.length) {
                out[p++] = 13;
                out[p++] = 10;
                col = 0;
            }
        }
        if (col > 0 || chunkData.length === 0) {
            out[p++] = 13;
            out[p++] = 10;
        }

        for (var f = 0; f < footerStr.length; f++) {
            out[p++] = footerStr.charCodeAt(f);
        }

        return out.subarray(0, p);
    }

    return {
        CRC32_TABLE: CRC32_TABLE,
        crc32Update: crc32Update,
        crc32: crc32,
        crc32Combine: crc32Combine,
        decodeYencArticle: decodeYencArticle,
        encodeYencArticle: encodeYencArticle
    };
}));
