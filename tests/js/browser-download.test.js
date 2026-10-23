/**
 * Spotweb Browser Download Engine - Comprehensive Integration & Unit Test Suite
 *
 * Tests all modules end-to-end:
 *   1. NZB Parser & Path Sanitizer (`nzb-parser.js`)
 *   2. Zero-Copy yEnc Decoder & CRC32 (`yenc-decoder.js`)
 *   3. PAR 2.0 Verification, Obfuscated File De-obfuscation & Striped GF(2^16) RS Repair (`par2-engine.js`)
 *   4. Disk-Backed Multi-Volume Archive Extraction (`archive-extractor.js`: RAR5, RAR4, 7z, ZIP, AES-256 passwords, path traversal protection)
 *   5. NNTP Client Pool & Full End-to-End Pipeline (`nntp-client.js`, `storage-manager.js`, `download-worker.js`)
 *      including missing/corrupt segment recovery via on-demand PAR2 volumes + RAR5 extraction + checkpoint resume.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const NzbParser = require('../../js/browser-download/nzb-parser.js');
const YencDecoder = require('../../js/browser-download/yenc-decoder.js');
const Par2Engine = require('../../js/browser-download/par2-engine.js');
const ArchiveExtractor = require('../../js/browser-download/archive-extractor.js');
const NntpClient = require('../../js/browser-download/nntp-client.js');
const StorageManager = require('../../js/browser-download/storage-manager.js');
const DownloadWorker = require('../../js/browser-download/download-worker.js');
const SevenZipFactory = require('../../js/browser-download/vendor/7zz.umd.js');

const wasmBinary = fs.readFileSync(
    path.join(__dirname, '../../js/browser-download/vendor/7zz.wasm')
);

// ============================================================================
// Helper: Node.js fd-backed SyncAccessHandle & Workspace (mirrors Browser OPFS)
// ============================================================================
class NodeDiskSyncHandle {
    constructor(filePath) {
        this.filePath = filePath;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        this.fd = fs.openSync(filePath, fs.existsSync(filePath) ? 'r+' : 'w+');
        this.closed = false;
    }
    getSize() {
        return fs.fstatSync(this.fd).size;
    }
    read(view, opts = {}) {
        const at = opts.at || 0;
        return fs.readSync(this.fd, view, 0, view.byteLength, at);
    }
    write(view, opts = {}) {
        const at = opts.at || 0;
        return fs.writeSync(this.fd, view, 0, view.byteLength, at);
    }
    truncate(newSize) {
        fs.ftruncateSync(this.fd, newSize);
    }
    flush() {
        fs.fsyncSync(this.fd);
    }
    close() {
        if (!this.closed) {
            this.closed = true;
            try { fs.closeSync(this.fd); } catch (_) {}
        }
    }
}

class NodeDiskWorkspace {
    constructor(baseDir) {
        this.baseDir = baseDir;
        this.stagingPath = path.join(baseDir, 'staging');
        this.extractedPath = path.join(baseDir, 'extracted');
        fs.mkdirSync(this.stagingPath, { recursive: true });
        fs.mkdirSync(this.extractedPath, { recursive: true });
        this.openHandles = new Map();
    }
    async openSyncHandle(area, filename) {
        const safeName = NzbParser.sanitizeFilename(filename);
        const key = `${area}:${safeName}`;
        const existing = this.openHandles.get(key);
        if (existing && !existing.closed) return existing;
        const dir = area === 'extracted' ? this.extractedPath : this.stagingPath;
        const h = new NodeDiskSyncHandle(path.join(dir, safeName));
        this.openHandles.set(key, h);
        return h;
    }
    closeSyncHandle(area, filename) {
        const safeName = NzbParser.sanitizeFilename(filename);
        const key = `${area}:${safeName}`;
        const existing = this.openHandles.get(key);
        if (existing) {
            existing.close();
            this.openHandles.delete(key);
        }
    }
    closeAllHandles() {
        for (const h of this.openHandles.values()) {
            h.close();
        }
        this.openHandles.clear();
    }
    async renameStagingFile(oldName, newName) {
        const safeOld = NzbParser.sanitizeFilename(oldName);
        const safeNew = NzbParser.sanitizeFilename(newName);
        this.closeSyncHandle('staging', safeOld);
        this.closeSyncHandle('staging', safeNew);
        fs.renameSync(path.join(this.stagingPath, safeOld), path.join(this.stagingPath, safeNew));
    }
    async listFiles(area) {
        const dir = area === 'extracted' ? this.extractedPath : this.stagingPath;
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).map((name) => ({
            name,
            handle: {
                kind: 'file',
                name,
                async getFile() {
                    const buf = fs.readFileSync(path.join(dir, name));
                    return new Blob([buf]);
                }
            }
        }));
    }
}

// ============================================================================
// Helper: Spec-Compliant RAR5 & RAR4 Multi-Volume Fixture Builders (Store Mode)
// ============================================================================
function toVint(n) {
    const out = [];
    let val = BigInt(n);
    while (val >= 0x80n) {
        out.push(Number((val & 0x7fn) | 0x80n));
        val >>= 7n;
    }
    out.push(Number(val));
    return Buffer.from(out);
}

function makeRar5Header(type, flags, extraBuf, bodyBuf, dataSize) {
    const typeV = toVint(type);
    const hasExtra = extraBuf && extraBuf.length > 0;
    const hasData = dataSize !== undefined && dataSize !== null;
    let hdrFlags = flags;
    if (hasExtra) hdrFlags |= 0x0001;
    if (hasData) hdrFlags |= 0x0002;
    const flagsV = toVint(hdrFlags);
    const extraLenV = hasExtra ? toVint(extraBuf.length) : Buffer.alloc(0);
    const dataLenV = hasData ? toVint(dataSize) : Buffer.alloc(0);
    const contentAfterSize = Buffer.concat([
        typeV,
        flagsV,
        extraLenV,
        dataLenV,
        bodyBuf || Buffer.alloc(0),
        extraBuf || Buffer.alloc(0)
    ]);
    const sizeV = toVint(contentAfterSize.length);
    const toCrc = Buffer.concat([sizeV, contentAfterSize]);
    const crcVal = YencDecoder.crc32(toCrc);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32LE(crcVal >>> 0, 0);
    return Buffer.concat([crcBuf, toCrc]);
}

function createRar5Volumes(innerFilename, payloadBytes, numVolumes) {
    const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
    const fullCrc = YencDecoder.crc32(payloadBytes);
    const nameBuf = Buffer.from(innerFilename, 'utf8');
    const chunkSize = Math.ceil(payloadBytes.length / numVolumes);
    const volumes = [];

    for (let i = 0; i < numVolumes; i++) {
        const start = i * chunkSize;
        const end = Math.min(payloadBytes.length, start + chunkSize);
        const chunk = Buffer.from(payloadBytes.subarray(start, end));
        const isFirst = (i === 0);
        const isLast = (i === numVolumes - 1);

        let arcFlags = numVolumes > 1 ? 0x0001 : 0x0000;
        let volNumBuf = Buffer.alloc(0);
        if (i > 0) {
            arcFlags |= 0x0002;
            volNumBuf = toVint(i);
        }
        const mainBody = Buffer.concat([toVint(arcFlags), volNumBuf]);
        const mainHdr = makeRar5Header(1, 0, null, mainBody, null);

        let hdrFlags = 0;
        if (!isFirst) hdrFlags |= 0x0008; // HFL_SPLITBEFORE
        if (!isLast) hdrFlags |= 0x0010;  // HFL_SPLITAFTER

        const fileFlags = isLast ? 0x0004 : 0x0000;
        const fileCrcBuf = Buffer.alloc(4);
        fileCrcBuf.writeUInt32LE(fullCrc >>> 0, 0);

        const fileBody = Buffer.concat([
            toVint(fileFlags),
            toVint(payloadBytes.length),
            toVint(0x20),
            isLast ? fileCrcBuf : Buffer.alloc(0),
            toVint(0),
            toVint(0),
            toVint(nameBuf.length),
            nameBuf
        ]);
        const fileHdr = makeRar5Header(2, hdrFlags, null, fileBody, chunk.length);
        const endFlags = isLast ? 0x0000 : 0x0001;
        const endHdr = makeRar5Header(5, 0, null, toVint(endFlags), null);

        const volName = numVolumes > 1
            ? `release.part${String(i + 1).padStart(2, '0')}.rar`
            : `release.rar`;
        volumes.push({
            name: volName,
            data: new Uint8Array(Buffer.concat([RAR5_SIG, mainHdr, fileHdr, chunk, endHdr]))
        });
    }
    return volumes;
}

function createRar4Volumes(innerFilename, payloadBytes, numVolumes) {
    const RAR4_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
    const fullCrc = YencDecoder.crc32(payloadBytes);
    const nameBytes = Buffer.from(innerFilename, 'utf8');
    const chunkSize = Math.ceil(payloadBytes.length / numVolumes);
    const volumes = [];

    function makeRar4Block(type, flags, bodyAfterBase, addSize) {
        let finalFlags = flags;
        let addBuf = Buffer.alloc(0);
        if (addSize !== undefined && addSize !== null) {
            finalFlags |= 0x8000;
            addBuf = Buffer.alloc(4);
            addBuf.writeUInt32LE(addSize >>> 0, 0);
        }
        const totalHeaderSize = 7 + addBuf.length + bodyAfterBase.length;
        const hdrAfterCrc = Buffer.alloc(5 + addBuf.length + bodyAfterBase.length);
        hdrAfterCrc.writeUInt8(type, 0);
        hdrAfterCrc.writeUInt16LE(finalFlags, 1);
        hdrAfterCrc.writeUInt16LE(totalHeaderSize, 3);
        addBuf.copy(hdrAfterCrc, 5);
        bodyAfterBase.copy(hdrAfterCrc, 5 + addBuf.length);
        const crc32Val = YencDecoder.crc32(hdrAfterCrc);
        const crc16 = crc32Val & 0xffff;
        const crcBuf = Buffer.alloc(2);
        crcBuf.writeUInt16LE(crc16, 0);
        return Buffer.concat([crcBuf, hdrAfterCrc]);
    }

    for (let i = 0; i < numVolumes; i++) {
        const start = i * chunkSize;
        const end = Math.min(payloadBytes.length, start + chunkSize);
        const chunk = Buffer.from(payloadBytes.subarray(start, end));
        const isFirst = (i === 0);
        const isLast = (i === numVolumes - 1);

        let mFlags = numVolumes > 1 ? 0x0001 : 0x0000;
        if (isFirst && numVolumes > 1) mFlags |= 0x0100;
        const mainHdr = makeRar4Block(0x73, mFlags, Buffer.alloc(6), null);

        let fFlags = 0x8000;
        if (!isFirst) fFlags |= 0x01;
        if (!isLast) fFlags |= 0x02;

        const fBody = Buffer.alloc(21 + nameBytes.length);
        fBody.writeUInt32LE(payloadBytes.length >>> 0, 0);
        fBody.writeUInt8(0, 4);
        const chunkCrc = YencDecoder.crc32(chunk);
        fBody.writeUInt32LE((isLast ? fullCrc : chunkCrc) >>> 0, 5);
        fBody.writeUInt32LE(0x54453000, 9);
        fBody.writeUInt8(29, 13);
        fBody.writeUInt8(0x30, 14);
        fBody.writeUInt16LE(nameBytes.length, 15);
        fBody.writeUInt32LE(0x20, 17);
        nameBytes.copy(fBody, 21);

        const fileHdr = makeRar4Block(0x74, fFlags, fBody, chunk.length);
        let eFlags = 0x4000;
        if (!isLast) eFlags |= 0x0001;
        const endHdr = makeRar4Block(0x7b, eFlags, Buffer.alloc(0), null);

        const ext = i === 0 ? '.rar' : `.r${String(i - 1).padStart(2, '0')}`;
        volumes.push({
            name: `legacy_release${ext}`,
            data: new Uint8Array(Buffer.concat([RAR4_SIG, mainHdr, fileHdr, chunk, endHdr]))
        });
    }
    return volumes;
}

// ============================================================================
// Test Runner
// ============================================================================
async function runAllTests() {
    let passed = 0;
    async function test(name, fn) {
        const t0 = Date.now();
        await fn();
        const ms = Date.now() - t0;
        console.log(`  [PASS] ${name} (${ms} ms)`);
        passed++;
    }

    console.log('=== Spotweb Browser Download Engine Test Suite ===\n');

    // ------------------------------------------------------------------------
    // 1. NZB Parser & Path Security Tests
    // ------------------------------------------------------------------------
    await test('1. NZB Parser parses metadata, classifies files, and orders segments', async () => {
        const sampleNzb = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head>
    <meta type="title">Ubuntu &amp; Mint ISO</meta>
    <meta type="password">s3cr3t!</meta>
  </head>
  <file poster="spotter@usenet.example" date="1700000000" subject="[01/10] - &quot;linux.part01.rar&quot; yEnc (1/2)">
    <groups><group>alt.binaries.boneless</group></groups>
    <segments>
      <segment bytes="384000" number="2">&lt;seg2@news.example.com&gt;</segment>
      <segment bytes="384000" number="1">&lt;seg1@news.example.com&gt;</segment>
    </segments>
  </file>
  <file poster="spotter@usenet.example" date="1700000001" subject="[02/10] - &quot;linux.par2&quot; yEnc (1/1)">
    <groups><group>alt.binaries.boneless</group></groups>
    <segments>
      <segment bytes="12000" number="1">par2idx@news.example.com</segment>
    </segments>
  </file>
  <file poster="spotter@usenet.example" date="1700000002" subject="[03/10] - &quot;linux.vol00+04.par2&quot; yEnc (1/1)">
    <groups><group>alt.binaries.boneless</group></groups>
    <segments>
      <segment bytes="150000" number="1">par2vol@news.example.com</segment>
    </segments>
  </file>
</nzb>`;

        const parsed = NzbParser.parseNzb(sampleNzb);
        assert.strictEqual(parsed.meta.title, 'Ubuntu & Mint ISO');
        assert.strictEqual(parsed.meta.password, 's3cr3t!');
        assert.strictEqual(parsed.files.length, 3);
        assert.strictEqual(parsed.files[0].filename, 'linux.part01.rar');
        assert.strictEqual(parsed.files[0].role, 'archive');
        assert.strictEqual(parsed.files[0].segments[0].number, 1);
        assert.strictEqual(parsed.files[0].segments[0].messageId, 'seg1@news.example.com');
        assert.strictEqual(parsed.files[1].role, 'par2-index');
        assert.strictEqual(parsed.files[2].role, 'par2-volume');
        assert.strictEqual(parsed.files[2].par2BlockCount, 4);
    });

    await test('2. Path sanitizer neutralizes path traversal, drive letters, and reserved names', async () => {
        assert.strictEqual(NzbParser.sanitizeFilename('../../etc/passwd'), 'passwd');
        assert.strictEqual(NzbParser.sanitizeFilename('C:\\Windows\\System32\\cmd.exe'), 'cmd.exe');
        assert.strictEqual(NzbParser.sanitizeFilename('CON.txt'), '_CON.txt');
        assert.throws(() => {
            NzbParser.validateAndSanitizeRelativePath('../../../var/www/shell.php');
        }, /Path traversal/);
        assert.throws(() => {
            NzbParser.validateAndSanitizeRelativePath('C:\\Users\\Admin\\Desktop\\autorun.inf');
        }, /drive-prefixed path/);
        assert.strictEqual(
            NzbParser.validateAndSanitizeRelativePath('SubFolder\\Track 01.flac'),
            'SubFolder/Track 01.flac'
        );
    });

    // ------------------------------------------------------------------------
    // 2. Zero-Copy yEnc Decoder & CRC32 Tests
    // ------------------------------------------------------------------------
    await test('3. yEnc encoder/decoder roundtrips all byte values (0x00..0xFF) & verifies CRC32', async () => {
        const rawData = new Uint8Array(65536);
        for (let i = 0; i < rawData.length; i++) {
            rawData[i] = (i * 73 + (i >> 8)) & 0xff;
        }
        const totalCrc = YencDecoder.crc32(rawData);
        const part1 = rawData.subarray(0, 32768);
        const part2 = rawData.subarray(32768);

        const art1 = YencDecoder.encodeYencArticle(part1, {
            filename: 'binary.dat',
            totalSize: rawData.length,
            part: 1,
            totalParts: 2,
            offset: 0,
            fileCrc32: totalCrc
        });
        const art2 = YencDecoder.encodeYencArticle(part2, {
            filename: 'binary.dat',
            totalSize: rawData.length,
            part: 2,
            totalParts: 2,
            offset: 32768,
            fileCrc32: totalCrc
        });

        const dec1 = YencDecoder.decodeYencArticle(art1, { strictCrc: true });
        const dec2 = YencDecoder.decodeYencArticle(art2, { strictCrc: true });

        assert.strictEqual(dec1.offset, 0);
        assert.strictEqual(dec2.offset, 32768);
        assert.deepStrictEqual(dec1.data, part1);
        assert.deepStrictEqual(dec2.data, part2);

        const combinedCrc = YencDecoder.crc32Combine(dec1.crc32, dec2.crc32, dec2.size);
        assert.strictEqual(combinedCrc, totalCrc);

        // Corrupt a byte in art2 and verify strictCrc throws a CRC mismatch
        const corruptArt = new Uint8Array(art2);
        corruptArt[120] ^= 0x05;
        assert.throws(() => {
            YencDecoder.decodeYencArticle(corruptArt, { strictCrc: true });
        }, /CRC32 mismatch|size/);
    });

    // ------------------------------------------------------------------------
    // 3. PAR2 Engine Verification, De-obfuscation & Striped GF(2^16) Repair
    // ------------------------------------------------------------------------
    await test('4. PAR2 Engine verifies, de-obfuscates renamed files, and repairs missing/corrupt slices', async () => {
        const file1Data = new Uint8Array(100000);
        const file2Data = new Uint8Array(75000);
        for (let i = 0; i < file1Data.length; i++) file1Data[i] = (i * 31 + 7) & 0xff;
        for (let i = 0; i < file2Data.length; i++) file2Data[i] = (i * 19 + 3) & 0xff;

        const sliceSize = 16384; // 7 slices in file1 + 5 slices in file2 = 12 slices
        const par2Vols = Par2Engine.createPar2Volumes(
            [
                { filename: 'video.part01.rar', data: file1Data },
                { filename: 'video.part02.rar', data: file2Data }
            ],
            sliceSize,
            4 // 4 recovery blocks
        );

        // Set up in-memory disk provider with:
        // - file1 obfuscated as "x98a7bc65.bin" and having 2 corrupted slices
        // - file2 truncated and having 1 corrupted slice (total 3 damaged slices <= 4 recovery blocks)
        const filesMap = new Map();
        const damagedFile1 = new Uint8Array(file1Data);
        // Keep first 16KB intact so hash_16k de-obfuscation matches, corrupt slices 2 and 4
        damagedFile1.fill(0xAA, sliceSize * 2, sliceSize * 2 + 500);
        damagedFile1.fill(0x55, sliceSize * 4, sliceSize * 4 + 500);
        filesMap.set('x98a7bc65.bin', damagedFile1);

        // Truncate last slice of file2
        filesMap.set('video.part02.rar', new Uint8Array(file2Data.subarray(0, file2Data.length - 5000)));

        const memProvider = {
            exists: (name) => filesMap.has(name),
            getSize: (name) => (filesMap.get(name) || new Uint8Array(0)).length,
            read: (name, view, offset) => {
                const f = filesMap.get(name);
                if (!f || offset >= f.length) return 0;
                const len = Math.min(view.length, f.length - offset);
                view.set(f.subarray(offset, offset + len));
                return len;
            },
            write: (name, view, offset) => {
                let f = filesMap.get(name) || new Uint8Array(0);
                if (offset + view.length > f.length) {
                    const grown = new Uint8Array(offset + view.length);
                    grown.set(f);
                    f = grown;
                    filesMap.set(name, f);
                }
                f.set(view, offset);
                return view.length;
            },
            truncate: (name, sz) => {
                const f = filesMap.get(name);
                if (!f) return;
                if (sz <= f.length) {
                    filesMap.set(name, f.slice(0, sz));
                }
            },
            listFiles: () => Array.from(filesMap.keys()),
            rename: (oldN, newN) => {
                const f = filesMap.get(oldN);
                filesMap.delete(oldN);
                filesMap.set(newN, f);
            }
        };

        const par2Set = Par2Engine.parsePar2Packets(par2Vols.volumePar2);
        const verifyBefore = Par2Engine.verifyFiles(par2Set, memProvider);
        assert.strictEqual(verifyBefore.allValid, false);
        assert.strictEqual(verifyBefore.damagedSliceCount, 3);
        assert.strictEqual(filesMap.has('video.part01.rar'), true, 'Obfuscated file should be renamed to video.part01.rar');

        const repairRes = Par2Engine.repairFiles(par2Set, verifyBefore, memProvider, { stripeSize: 4096 });
        assert.strictEqual(repairRes.repaired, true);
        assert.strictEqual(repairRes.repairedSliceCount, 3);
        assert.deepStrictEqual(filesMap.get('video.part01.rar'), file1Data);
        assert.deepStrictEqual(filesMap.get('video.part02.rar'), file2Data);
    });

    await test('5. PAR2 Engine clearly reports insufficient recovery blocks when damage exceeds parity', async () => {
        const data = new Uint8Array(32768);
        for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
        const par2Vols = Par2Engine.createPar2Volumes(
            [{ filename: 'data.bin', data }],
            8192, // 4 slices
            1     // Only 1 recovery block
        );
        const par2Set = Par2Engine.parsePar2Packets(par2Vols.volumePar2);
        // Missing entire file = 4 damaged slices, only 1 recovery block
        const emptyProvider = {
            exists: () => false,
            getSize: () => 0,
            read: () => 0,
            write: () => 0,
            truncate: () => {},
            listFiles: () => []
        };
        assert.throws(() => {
            Par2Engine.repairFiles(par2Set, null, emptyProvider);
        }, /Insufficient PAR2 recovery blocks/);
    });

    // ------------------------------------------------------------------------
    // 4. Disk-Backed Multi-Volume Archive Extraction (RAR5, RAR4, Passwords, Obfuscation)
    // ------------------------------------------------------------------------
    await test('6. ArchiveExtractor extracts multi-volume RAR5 & RAR4 via zero-RAM SyncHandleFS', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-rar-'));
        try {
            const payload = new Uint8Array(512 * 1024);
            for (let i = 0; i < payload.length; i++) payload[i] = (i * 97 + 13) & 0xff;

            // Test 3-part RAR5 (with obfuscated volume names to also test magic-byte de-obfuscation!)
            const rar5Vols = createRar5Volumes('Nested/MovieClip.mkv', payload, 3);
            const obfNames = ['99a8b7c6.001', '11d2e3f4.bin', '55a6b7c8.dat'];
            const inputHandles = [];
            for (let i = 0; i < rar5Vols.length; i++) {
                const p = path.join(tmpDir, obfNames[i]);
                fs.writeFileSync(p, rar5Vols[i].data);
                inputHandles.push({ name: obfNames[i], handle: new NodeDiskSyncHandle(p) });
            }

            const outHandles = new Map();
            const res5 = await ArchiveExtractor.extractArchive({
                inputVolumes: inputHandles,
                wasmOptions: { sevenZipFactory: SevenZipFactory, wasmBinary },
                createOutputHandle: async (safeRelPath) => {
                    const outPath = path.join(tmpDir, 'out5', safeRelPath);
                    const h = new NodeDiskSyncHandle(outPath);
                    outHandles.set(safeRelPath, { handle: h, path: outPath });
                    return h;
                }
            });

            inputHandles.forEach((v) => v.handle.close());
            for (const o of outHandles.values()) o.handle.close();

            assert.strictEqual(res5.extractedFiles.length, 1);
            assert.strictEqual(res5.extractedFiles[0].path, 'Nested/MovieClip.mkv');
            const extractedBytes5 = new Uint8Array(fs.readFileSync(outHandles.get('Nested/MovieClip.mkv').path));
            assert.deepStrictEqual(extractedBytes5, payload);

            // Test 3-part RAR4 (.rar, .r00, .r01)
            const rar4Vols = createRar4Volumes('Audio/Track01.flac', payload, 3);
            const inputHandles4 = [];
            for (let i = 0; i < rar4Vols.length; i++) {
                const p = path.join(tmpDir, rar4Vols[i].name);
                fs.writeFileSync(p, rar4Vols[i].data);
                inputHandles4.push({ name: rar4Vols[i].name, handle: new NodeDiskSyncHandle(p) });
            }
            const outHandles4 = new Map();
            const res4 = await ArchiveExtractor.extractArchive({
                inputVolumes: inputHandles4,
                wasmOptions: { sevenZipFactory: SevenZipFactory, wasmBinary },
                createOutputHandle: async (safeRelPath) => {
                    const outPath = path.join(tmpDir, 'out4', safeRelPath);
                    const h = new NodeDiskSyncHandle(outPath);
                    outHandles4.set(safeRelPath, { handle: h, path: outPath });
                    return h;
                }
            });
            inputHandles4.forEach((v) => v.handle.close());
            for (const o of outHandles4.values()) o.handle.close();

            assert.strictEqual(res4.extractedFiles[0].path, 'Audio/Track01.flac');
            const extractedBytes4 = new Uint8Array(fs.readFileSync(outHandles4.get('Audio/Track01.flac').path));
            assert.deepStrictEqual(extractedBytes4, payload);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await test('7. ArchiveExtractor handles password-protected archives (7z AES-256) and wrong passwords', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-pw-'));
        try {
            const secretPayload = Buffer.from('Spotweb Browser Download Encrypted Payload Verification!', 'utf8');
            const srcFile = path.join(tmpDir, 'secret.txt');
            const arcFile = path.join(tmpDir, 'protected.7z');
            fs.writeFileSync(srcFile, secretPayload);

            // Create an AES-256 password-protected 7z archive using 7z-wasm
            const szCreate = await SevenZipFactory({ wasmBinary, print: () => {}, printErr: () => {} });
            szCreate.FS.mkdir('/work');
            szCreate.FS.writeFile('/work/secret.txt', new Uint8Array(secretPayload));
            szCreate.callMain(['a', '-t7z', '-pCorrectHorseBatteryStaple', '/work/protected.7z', '/work/secret.txt']);
            const arcBytes = szCreate.FS.readFile('/work/protected.7z');
            fs.writeFileSync(arcFile, arcBytes);

            const arcHandle = new NodeDiskSyncHandle(arcFile);

            // 1) Wrong password -> throws WRONG_PASSWORD or PASSWORD_REQUIRED
            let caughtCode = null;
            try {
                await ArchiveExtractor.extractArchive({
                    inputVolumes: [{ name: 'protected.7z', handle: arcHandle }],
                    password: 'WrongPassword123',
                    wasmOptions: { sevenZipFactory: SevenZipFactory, wasmBinary },
                    createOutputHandle: async (rel) => new NodeDiskSyncHandle(path.join(tmpDir, 'bad', rel))
                });
            } catch (err) {
                caughtCode = err.code;
            }
            assert.ok(
                caughtCode === 'WRONG_PASSWORD' || caughtCode === 'PASSWORD_REQUIRED',
                `Expected WRONG_PASSWORD or PASSWORD_REQUIRED, got ${caughtCode}`
            );

            // 2) Correct password -> succeeds and matches byte-for-byte
            const goodOut = new Map();
            const res = await ArchiveExtractor.extractArchive({
                inputVolumes: [{ name: 'protected.7z', handle: arcHandle }],
                password: 'CorrectHorseBatteryStaple',
                wasmOptions: { sevenZipFactory: SevenZipFactory, wasmBinary },
                createOutputHandle: async (rel) => {
                    const p = path.join(tmpDir, 'good', rel);
                    const h = new NodeDiskSyncHandle(p);
                    goodOut.set(rel, { handle: h, path: p });
                    return h;
                }
            });
            arcHandle.close();
            for (const o of goodOut.values()) o.handle.close();

            assert.strictEqual(res.extractedFiles.length, 1);
            assert.deepStrictEqual(fs.readFileSync(goodOut.get('secret.txt').path), secretPayload);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // ------------------------------------------------------------------------
    // 5. Full End-to-End Pipeline Test (NNTP Relay + Missing/Corrupt Articles +
    //    On-Demand PAR2 Fetch + GF(2^16) Repair + Multi-Volume RAR5 Extraction)
    // ------------------------------------------------------------------------
    await test('8. End-to-End Pipeline: downloads NZB, repairs missing/corrupt NNTP articles via PAR2, and extracts multi-volume RAR5', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-e2e-'));
        let server = null;
        try {
            // 1. Create a 600 KB payload packed into a 2-volume RAR5 archive
            const originalPayload = new Uint8Array(600 * 1024);
            for (let i = 0; i < originalPayload.length; i++) {
                originalPayload[i] = (i * 41 + (i >> 7)) & 0xff;
            }
            const rarVols = createRar5Volumes('FinalOutput/LinuxDistro.iso', originalPayload, 2);

            // 2. Create PAR2 index + recovery volume (`sliceSize = 32768`, 4 recovery blocks)
            const par2Data = Par2Engine.createPar2Volumes(
                rarVols.map((v) => ({ filename: v.name, data: v.data })),
                32768,
                4
            );

            // 3. Slice files into yEnc NNTP segments (64 KB per segment) and build NZB XML
            const articlesById = new Map();
            const nzbFileBlocks = [];
            const allFilesToPost = [
                { name: rarVols[0].name, data: rarVols[0].data },
                { name: rarVols[1].name, data: rarVols[1].data },
                { name: 'release.par2', data: par2Data.indexPar2 },
                { name: 'release.vol00+04.par2', data: par2Data.volumePar2 }
            ];

            const segSize = 65536;
            for (let fIdx = 0; fIdx < allFilesToPost.length; fIdx++) {
                const fileObj = allFilesToPost[fIdx];
                const totalParts = Math.ceil(fileObj.data.length / segSize) || 1;
                const fileCrc = YencDecoder.crc32(fileObj.data);
                const segXmls = [];

                for (let p = 0; p < totalParts; p++) {
                    const start = p * segSize;
                    const end = Math.min(fileObj.data.length, start + segSize);
                    const chunk = fileObj.data.subarray(start, end);
                    const msgId = `f${fIdx}.p${p + 1}@test.spotweb.local`;
                    const yencBytes = YencDecoder.encodeYencArticle(chunk, {
                        filename: fileObj.name,
                        totalSize: fileObj.data.length,
                        part: p + 1,
                        totalParts,
                        offset: start,
                        fileCrc32: fileCrc
                    });
                    articlesById.set(msgId, { status: 222, body: yencBytes });
                    segXmls.push(`      <segment bytes="${chunk.length}" number="${p + 1}">${msgId}</segment>`);
                }

                nzbFileBlocks.push(`  <file poster="test@spotweb" date="1700000000" subject="[0${fIdx + 1}/04] - &quot;${fileObj.name}&quot; yEnc (1/${totalParts})">
    <groups><group>alt.binaries.test</group></groups>
    <segments>
${segXmls.join('\n')}
    </segments>
  </file>`);
            }

            // Intentionally inject Usenet damage:
            // - Make segment 2 of part01.rar return 430 No such article (2 missing PAR2 slices!)
            articlesById.set('f0.p2@test.spotweb.local', { status: 430, body: new Uint8Array(0) });

            const nzbXml = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head><meta type="title">E2E Damaged Multi-Volume Release</meta></head>
${nzbFileBlocks.join('\n')}
</nzb>`;

            // 4. Start local HTTP Batch Relay Server
            server = http.createServer((req, res) => {
                let body = '';
                req.on('data', (c) => { body += c; });
                req.on('end', () => {
                    const reqData = JSON.parse(body);
                    const frames = (reqData.messageIds || []).map((id) => {
                        const art = articlesById.get(id);
                        if (!art) return { status: 430, messageId: id, body: new Uint8Array(0) };
                        return { status: art.status, messageId: id, body: art.body };
                    });
                    const bin = NntpClient.encodeBinaryBatchFrames(frames);
                    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                    res.end(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength));
                });
            });

            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            const port = server.address().port;

            // 5. Run DownloadJobRunner end-to-end
            const workspace = new NodeDiskWorkspace(tmpDir);
            const statesSeen = [];
            const runner = new DownloadWorker.DownloadJobRunner({
                jobId: 'e2e_test_1',
                nzbXml,
                relayConfig: {
                    mode: 'http',
                    httpBatchUrl: `http://127.0.0.1:${port}/batch`,
                    maxConnections: 4,
                    batchSize: 3
                },
                workspace,
                sevenZipFactory: SevenZipFactory,
                wasmBinary,
                skipExportToDir: true,
                keepWorkspaceOnComplete: true,
                onUpdate: (snap) => {
                    if (statesSeen[statesSeen.length - 1] !== snap.state) {
                        statesSeen.push(snap.state);
                    }
                }
            });

            await runner.run();

            assert.strictEqual(runner.state, 'completed');
            assert.strictEqual(runner.missingSegments, 1, 'Should detect 1 missing NNTP segment');
            assert.strictEqual(runner.repairedSlices, 2, 'Should repair 2 missing 32KB PAR2 slices');
            assert.ok(statesSeen.includes('downloading'));
            assert.ok(statesSeen.includes('verifying'));
            assert.ok(statesSeen.includes('repairing'));
            assert.ok(statesSeen.includes('extracting'));
            assert.ok(statesSeen.includes('completed'));

            // Verify the extracted ISO in workspace/extracted matches originalPayload byte-for-byte!
            const extractedFiles = fs.readdirSync(workspace.extractedPath);
            assert.strictEqual(extractedFiles.length, 1);
            const finalIsoBytes = new Uint8Array(
                fs.readFileSync(path.join(workspace.extractedPath, extractedFiles[0]))
            );
            assert.deepStrictEqual(finalIsoBytes, originalPayload);
        } finally {
            if (server) server.close();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await test('9. ArchiveExtractor blocks archives containing path traversal entries (../../escape.bin)', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-trav-'));
        try {
            const payload = new Uint8Array(1024);
            const maliciousRar5 = createRar5Volumes('../../escape.bin', payload, 1);
            const p = path.join(tmpDir, 'evil.rar');
            fs.writeFileSync(p, maliciousRar5[0].data);
            const h = new NodeDiskSyncHandle(p);
            try {
                await assert.rejects(async () => {
                    await ArchiveExtractor.extractArchive({
                        inputVolumes: [{ name: 'evil.rar', handle: h }],
                        wasmOptions: { sevenZipFactory: SevenZipFactory, wasmBinary },
                        createOutputHandle: async () => {
                            throw new Error('Should never create output handle for malicious path');
                        }
                    });
                }, /Path traversal/);
            } finally {
                h.close();
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await test('10. NntpClientPool supports up to 100 connections and shares connection limit across concurrent pools', async () => {
        const highPool = new NntpClient.NntpClientPool({
            mode: 'http',
            httpBatchUrl: 'http://relay.local/high',
            maxConnections: 100,
            shareConnections: false
        });
        assert.strictEqual(highPool.maxConnections, 100);

        const clampedPool = new NntpClient.NntpClientPool({
            mode: 'http',
            httpBatchUrl: 'http://relay.local/clamped',
            maxConnections: 250,
            shareConnections: false
        });
        assert.strictEqual(clampedPool.maxConnections, 100);

        let inFlight = 0;
        let maxObservedInFlight = 0;
        const sharedUrl = 'http://relay.local/shared-cap-test';

        const fakeFetch = async (_url, init) => {
            inFlight++;
            if (inFlight > maxObservedInFlight) {
                maxObservedInFlight = inFlight;
            }
            const req = JSON.parse(init.body);
            await new Promise((r) => setTimeout(r, 15));
            inFlight--;
            const frames = req.messageIds.map((id) => ({
                status: 222,
                messageId: id,
                body: new Uint8Array([1, 2, 3])
            }));
            const encoded = NntpClient.encodeBinaryBatchFrames(frames);
            return {
                ok: true,
                status: 200,
                arrayBuffer: async () => encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
            };
        };

        const poolA = new NntpClient.NntpClientPool({
            mode: 'http',
            httpBatchUrl: sharedUrl,
            maxConnections: 5,
            batchSize: 1,
            fetchImpl: fakeFetch
        });
        const poolB = new NntpClient.NntpClientPool({
            mode: 'http',
            httpBatchUrl: sharedUrl,
            maxConnections: 5,
            batchSize: 1,
            fetchImpl: fakeFetch
        });

        const tasksA = Array.from({ length: 12 }, (_, i) => ({ messageId: `a-${i}@test` }));
        const tasksB = Array.from({ length: 12 }, (_, i) => ({ messageId: `b-${i}@test` }));
        let completedA = 0;
        let completedB = 0;

        await Promise.all([
            poolA.downloadSegments(tasksA, async () => { completedA++; }),
            poolB.downloadSegments(tasksB, async () => { completedB++; })
        ]);

        assert.strictEqual(completedA, 12);
        assert.strictEqual(completedB, 12);
        assert.ok(maxObservedInFlight <= 5, `Expected shared in-flight <= 5, got ${maxObservedInFlight}`);
        assert.ok(maxObservedInFlight >= 2, `Expected parallel execution across pools, got ${maxObservedInFlight}`);
        poolA.close();
        poolB.close();
    });

    console.log(`\nAll ${passed} test suites passed!`);
}

runAllTests().catch((err) => {
    console.error('\n[FAIL]', err);
    process.exit(1);
});
