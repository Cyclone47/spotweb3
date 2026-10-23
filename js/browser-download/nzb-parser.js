/**
 * Spotweb Browser Download Engine - NZB Parser, Validator & Path Sanitizer
 * Runs in Browser Main Thread, Dedicated Web Worker, and Node.js.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SpotwebNzbParser = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

    function decodeXmlEntities(str) {
        if (!str || typeof str !== 'string') {
            return '';
        }
        return str
            .replace(/&#x([0-9a-fA-F]+);/g, function (_, hex) {
                var code = parseInt(hex, 16);
                return code > 0 ? String.fromCodePoint(code) : '';
            })
            .replace(/&#(\d+);/g, function (_, dec) {
                var code = parseInt(dec, 10);
                return code > 0 ? String.fromCodePoint(code) : '';
            })
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    }

    function parseAttributes(attrString) {
        var attrs = {};
        if (!attrString) {
            return attrs;
        }
        var re = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        var match;
        while ((match = re.exec(attrString)) !== null) {
            var val = match[2] !== undefined ? match[2] : match[3];
            attrs[match[1].toLowerCase()] = decodeXmlEntities(val);
        }
        return attrs;
    }

    /**
     * Extract filename from Usenet subject header.
     * Standard format: ... "filename.ext" yEnc (1/25)
     */
    function extractFilenameFromSubject(subject, fallbackIndex) {
        if (!subject || typeof subject !== 'string') {
            return 'file_' + (fallbackIndex || 1) + '.bin';
        }
        var s = subject.trim();
        // Match last quoted string before yEnc or at end
        var quotedMatches = [];
        var qRe = /"([^"]+)"/g;
        var m;
        while ((m = qRe.exec(s)) !== null) {
            var candidate = m[1].trim();
            if (candidate.length > 0) {
                quotedMatches.push(candidate);
            }
        }
        if (quotedMatches.length > 0) {
            return quotedMatches[quotedMatches.length - 1];
        }

        // Fallback: look for token with file extension before yEnc / (1/N)
        var stripped = s.replace(/\(\d+\/\d+\)\s*$/g, '').replace(/\byEnc\b.*$/i, '').trim();
        var tokens = stripped.split(/\s+/);
        for (var i = tokens.length - 1; i >= 0; i--) {
            if (/\.[a-zA-Z0-9]{2,6}$/.test(tokens[i])) {
                return tokens[i];
            }
        }
        return stripped || ('file_' + (fallbackIndex || 1) + '.bin');
    }

    /**
     * Validate and sanitize a single filename (no directory components allowed).
     */
    function sanitizeFilename(rawName, fallbackName) {
        if (!rawName || typeof rawName !== 'string') {
            rawName = fallbackName || 'download.bin';
        }
        // Normalize slashes and take basename only if subject contained path separators
        var cleaned = rawName.replace(/\\/g, '/').split('/').pop().trim();
        // Strip control characters and illegal filesystem chars
        cleaned = cleaned.replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_');
        // Strip leading/trailing dots and spaces
        cleaned = cleaned.replace(/^[.\s]+|[.\s]+$/g, '');
        if (!cleaned || cleaned === '.' || cleaned === '..') {
            cleaned = fallbackName || 'download.bin';
        }
        if (WINDOWS_RESERVED_RE.test(cleaned)) {
            cleaned = '_' + cleaned;
        }
        if (cleaned.length > 240) {
            var extMatch = cleaned.match(/(\.[a-zA-Z0-9.]{1,20})$/);
            var ext = extMatch ? extMatch[1] : '';
            cleaned = cleaned.slice(0, 240 - ext.length) + ext;
        }
        return cleaned;
    }

    /**
     * Validate and sanitize a relative archive extraction path.
     * Throws an Error if path traversal, absolute path, drive letter, or unsafe component is detected.
     */
    function validateAndSanitizeRelativePath(rawPath) {
        if (!rawPath || typeof rawPath !== 'string') {
            throw new Error('Archive entry has an empty or invalid path');
        }
        if (/[\x00-\x1f]/.test(rawPath)) {
            throw new Error('Archive entry path contains control characters: ' + JSON.stringify(rawPath));
        }
        var normalized = rawPath.replace(/\\/g, '/');
        if (normalized.charAt(0) === '/' || /^[a-zA-Z]:/.test(normalized)) {
            throw new Error('Archive entry uses an absolute or drive-prefixed path: ' + rawPath);
        }
        var rawSegments = normalized.split('/');
        var safeSegments = [];
        for (var i = 0; i < rawSegments.length; i++) {
            var seg = rawSegments[i];
            if (seg === '' || seg === '.') {
                continue;
            }
            if (seg === '..') {
                throw new Error('Path traversal ("..") detected in archive entry: ' + rawPath);
            }
            var cleanSeg = seg.replace(/[<>:"|?*]/g, '_').replace(/[.\s]+$/g, '');
            if (!cleanSeg || cleanSeg === '.' || cleanSeg === '..') {
                throw new Error('Invalid path segment in archive entry: ' + rawPath);
            }
            if (WINDOWS_RESERVED_RE.test(cleanSeg)) {
                cleanSeg = '_' + cleanSeg;
            }
            safeSegments.push(cleanSeg);
        }
        if (safeSegments.length === 0) {
            throw new Error('Archive entry resolved to an empty path: ' + rawPath);
        }
        return safeSegments.join('/');
    }

    /**
     * Classify an NZB file entry by filename.
     */
    function classifyFile(filename) {
        var lower = filename.toLowerCase();
        var parVolMatch = lower.match(/\.vol(\d+)\+(\d+)\.par2$/i);
        if (parVolMatch) {
            return {
                role: 'par2-volume',
                par2StartBlock: parseInt(parVolMatch[1], 10),
                par2BlockCount: parseInt(parVolMatch[2], 10),
                isArchive: false
            };
        }
        if (/\.par2$/i.test(lower)) {
            return {
                role: 'par2-index',
                par2StartBlock: 0,
                par2BlockCount: 0,
                isArchive: false
            };
        }
        var isRar = /\.(rar|r\d{2,3}|s\d{2,3})$/i.test(lower);
        var isZip = /\.(zip|z\d{2,3}|zipx)$/i.test(lower);
        var is7z = /\.(7z)(\.\d{3})?$/i.test(lower);
        var isSplit = /\.\d{3}$/.test(lower) && !is7z;
        if (isRar || isZip || is7z || isSplit) {
            return {
                role: 'archive',
                archiveFormat: isRar ? 'rar' : (isZip ? 'zip' : (is7z ? '7z' : 'split')),
                par2StartBlock: 0,
                par2BlockCount: 0,
                isArchive: true
            };
        }
        if (/\.(nfo|sfv|txt|srr|srs|nzb)$/i.test(lower)) {
            return {
                role: 'auxiliary',
                par2StartBlock: 0,
                par2BlockCount: 0,
                isArchive: false
            };
        }
        return {
            role: 'primary',
            par2StartBlock: 0,
            par2BlockCount: 0,
            isArchive: false
        };
    }

    /**
     * Validate a Usenet Message-ID (must not contain CR/LF/spaces or control chars).
     */
    function sanitizeMessageId(rawId) {
        if (!rawId || typeof rawId !== 'string') {
            throw new Error('Empty segment Message-ID in NZB');
        }
        var id = rawId.trim();
        if (id.charAt(0) === '<' && id.charAt(id.length - 1) === '>') {
            id = id.slice(1, -1).trim();
        }
        if (!id || /[\r\n\s<>]/.test(id) || /[\x00-\x1f\x7f]/.test(id)) {
            throw new Error('Malformed or unsafe segment Message-ID: ' + JSON.stringify(rawId));
        }
        return id;
    }

    /**
     * Parse and validate an NZB XML string.
     * Returns structured manifest: { meta, files, totalBytes, totalSegments }
     */
    function parseNzb(xmlString) {
        if (!xmlString || typeof xmlString !== 'string') {
            throw new Error('NZB content is empty or not a string');
        }
        if (!/<nzb[\s>]/i.test(xmlString)) {
            throw new Error('Invalid NZB XML: missing <nzb> root element');
        }

        var meta = {};
        var metaRe = /<meta\b([^>]*)>([\s\S]*?)<\/meta>/gi;
        var metaMatch;
        while ((metaMatch = metaRe.exec(xmlString)) !== null) {
            var mAttrs = parseAttributes(metaMatch[1]);
            if (mAttrs.type) {
                meta[mAttrs.type.toLowerCase()] = decodeXmlEntities(metaMatch[2].trim());
            }
        }

        var files = [];
        var usedFilenames = Object.create(null);
        var fileRe = /<file\b([^>]*)>([\s\S]*?)<\/file>/gi;
        var fileMatch;
        var fileIndex = 0;

        while ((fileMatch = fileRe.exec(xmlString)) !== null) {
            var fAttrs = parseAttributes(fileMatch[1]);
            var fBody = fileMatch[2];
            var subject = fAttrs.subject || '';
            var poster = fAttrs.poster || '';
            var date = parseInt(fAttrs.date || '0', 10) || 0;

            var rawFilename = extractFilenameFromSubject(subject, fileIndex + 1);
            var baseFilename = sanitizeFilename(rawFilename, 'file_' + (fileIndex + 1) + '.bin');

            // Ensure unique filename within job if duplicate subjects occur
            var filename = baseFilename;
            var dupCounter = 1;
            while (usedFilenames[filename.toLowerCase()]) {
                var dotIdx = baseFilename.lastIndexOf('.');
                if (dotIdx > 0) {
                    filename = baseFilename.slice(0, dotIdx) + '_' + dupCounter + baseFilename.slice(dotIdx);
                } else {
                    filename = baseFilename + '_' + dupCounter;
                }
                dupCounter++;
            }
            usedFilenames[filename.toLowerCase()] = true;

            var groups = [];
            var groupRe = /<group\b[^>]*>([\s\S]*?)<\/group>/gi;
            var groupMatch;
            while ((groupMatch = groupRe.exec(fBody)) !== null) {
                var grp = decodeXmlEntities(groupMatch[1].trim());
                if (grp && !/[\r\n\s]/.test(grp)) {
                    groups.push(grp);
                }
            }

            var segments = [];
            var seenNumbers = Object.create(null);
            var segRe = /<segment\b([^>]*)>([\s\S]*?)<\/segment>/gi;
            var segMatch;
            while ((segMatch = segRe.exec(fBody)) !== null) {
                var sAttrs = parseAttributes(segMatch[1]);
                var bytes = parseInt(sAttrs.bytes || '0', 10);
                var number = parseInt(sAttrs.number || '0', 10);
                var msgId = sanitizeMessageId(decodeXmlEntities(segMatch[2]));

                if (!Number.isFinite(bytes) || bytes <= 0) {
                    throw new Error('Invalid segment byte count in file "' + filename + '" (segment #' + number + ')');
                }
                if (!Number.isFinite(number) || number <= 0) {
                    throw new Error('Invalid segment number in file "' + filename + '"');
                }
                if (seenNumbers[number]) {
                    throw new Error('Duplicate segment number #' + number + ' in file "' + filename + '"');
                }
                seenNumbers[number] = true;
                segments.push({
                    number: number,
                    bytes: bytes,
                    messageId: msgId
                });
            }

            if (segments.length === 0) {
                throw new Error('File "' + filename + '" in NZB has no segments');
            }

            segments.sort(function (a, b) {
                return a.number - b.number;
            });

            // Calculate estimated offsets from NZB segment byte sizes (refined during yEnc =ypart decoding)
            var estimatedBytes = 0;
            for (var s = 0; s < segments.length; s++) {
                segments[s].estimatedOffset = estimatedBytes;
                estimatedBytes += segments[s].bytes;
            }

            var classification = classifyFile(filename);
            files.push({
                index: fileIndex,
                subject: subject,
                poster: poster,
                date: date,
                rawFilename: rawFilename,
                filename: filename,
                groups: groups,
                segments: segments,
                estimatedBytes: estimatedBytes,
                role: classification.role,
                archiveFormat: classification.archiveFormat || null,
                par2StartBlock: classification.par2StartBlock,
                par2BlockCount: classification.par2BlockCount,
                isArchive: classification.isArchive
            });
            fileIndex++;
        }

        if (files.length === 0) {
            throw new Error('NZB contains no <file> entries');
        }

        var totalBytes = 0;
        var totalSegments = 0;
        var activeBytes = 0;
        var activeSegments = 0;

        for (var i = 0; i < files.length; i++) {
            totalBytes += files[i].estimatedBytes;
            totalSegments += files[i].segments.length;
            if (files[i].role !== 'par2-volume') {
                activeBytes += files[i].estimatedBytes;
                activeSegments += files[i].segments.length;
            }
        }

        return {
            meta: meta,
            files: files,
            totalBytes: totalBytes,
            totalSegments: totalSegments,
            initialBytes: activeBytes,
            initialSegments: activeSegments
        };
    }

    return {
        decodeXmlEntities: decodeXmlEntities,
        extractFilenameFromSubject: extractFilenameFromSubject,
        sanitizeFilename: sanitizeFilename,
        validateAndSanitizeRelativePath: validateAndSanitizeRelativePath,
        classifyFile: classifyFile,
        sanitizeMessageId: sanitizeMessageId,
        parseNzb: parseNzb
    };
}));
