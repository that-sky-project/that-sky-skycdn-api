/**
 * Resource manifest ("TGCManifest") binary format, version 3 — the format the
 * 0.35.1 client requires (older builds used version 1, which differs only in
 * the header: no buildCL / resourceHash and a 40-byte header).
 *
 * Layout (all integers little-endian):
 *
 *   0  16  magic "\0TGCManifest\r\n\0\0"
 *   16  4  version        must be 3
 *   20  4  length         total file size; the client rejects a mismatch
 *   24  4  crc32          CRC-32 of the whole file with this field zeroed
 *   28  4  entryCount
 *   32  4  entryFields    must be 7
 *   36  4  buildCL        changelist the manifest was produced for
 *   40  4  resourceHash   content revision, compared against cache manifests
 *   44  …  entry table    entryCount rows of entryFields uint32
 *   …      payload        category strings, name strings, 20-byte SHA-1s
 *
 * Entry fields (disk order). String/blob fields store an *absolute* offset into
 * the file:
 *
 *   0  timestamp        unix seconds
 *   1  compressedSize   byte length the downloader expects for this blob
 *   2  category         offset of a NUL-terminated UTF-8 string
 *   3  name             offset of a NUL-terminated UTF-8 string
 *   4  pathHash         offset of 20 bytes: SHA-1 of the file contents
 *   5  size             uncompressed size (same as compressedSize in practice)
 *   6  type             0
 *
 * The client indexes entries by FNV-1a(name), so names must be unique.
 */

const zlib = require('zlib');

const MAGIC = Buffer.from('\0TGCManifest\r\n\0\0', 'latin1');
const VERSION = 3;
const HEADER_SIZE = 44;
const ENTRY_FIELDS = 7;
const ENTRY_SIZE = ENTRY_FIELDS * 4;
const PAYLOAD_HASH_LENGTH = 20;
const CRC_OFFSET = 24;

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

// zlib.crc32 exists since Node 22.2; keep a table fallback for older runtimes.
let crcTable = null;
function fallbackCrc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  return fallbackCrc32(buffer);
}

function crcOfManifest(buffer) {
  // The stored CRC covers the file with its own field zeroed out.
  const copy = Buffer.from(buffer);
  copy.writeUInt32LE(0, CRC_OFFSET);
  return crc32(copy);
}

function readUInt32(buffer, offset, field) {
  if (offset + 4 > buffer.length) {
    throw new ManifestError(`manifest truncated while reading ${field}`);
  }
  return buffer.readUInt32LE(offset);
}

function readCString(buffer, offset, field) {
  if (offset >= buffer.length) {
    throw new ManifestError(`${field} offset ${offset} is outside the manifest`);
  }
  let end = buffer.indexOf(0, offset);
  if (end === -1) end = buffer.length;
  return buffer.toString('utf8', offset, end);
}

function readHash(buffer, offset, field) {
  if (offset + PAYLOAD_HASH_LENGTH > buffer.length) {
    throw new ManifestError(`${field} offset ${offset} is outside the manifest`);
  }
  return Buffer.from(buffer.subarray(offset, offset + PAYLOAD_HASH_LENGTH));
}

function normalizeHash(hash) {
  if (Buffer.isBuffer(hash)) {
    if (hash.length !== PAYLOAD_HASH_LENGTH) {
      throw new ManifestError(`pathHash must be ${PAYLOAD_HASH_LENGTH} bytes`);
    }
    return Buffer.from(hash);
  }
  if (typeof hash === 'string' && /^[0-9a-f]{40}$/i.test(hash)) {
    return Buffer.from(hash, 'hex');
  }
  throw new ManifestError('pathHash must be a 20-byte Buffer or 40-char hex string');
}

function normalizeEntry(entry) {
  const category = String(entry.category ?? '').trim();
  const name = String(entry.name ?? '').trim();
  if (!category) throw new ManifestError('entry.category is required');
  if (!name) throw new ManifestError('entry.name is required');
  const size = Number(entry.size ?? entry.compressedSize ?? 0);
  if (!Number.isFinite(size) || size < 0) throw new ManifestError('entry.size must be >= 0');
  return {
    category,
    name,
    hash: normalizeHash(entry.hash),
    timestamp: Number.isFinite(Number(entry.timestamp)) ? Number(entry.timestamp) >>> 0 : 0,
    compressedSize: Number(entry.compressedSize ?? size) >>> 0,
    size: size >>> 0,
    type: Number(entry.type ?? 0) >>> 0,
  };
}

/**
 * Parse and validate a version-3 manifest.
 * @returns {{version:number,length:number,crc32:number,entryCount:number,
 *   entryFields:number,buildCL:number,resourceHash:number,entries:Array,buffer:Buffer}}
 */
function parseManifest(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new ManifestError('manifest must be a Buffer');
  if (buffer.length < HEADER_SIZE) throw new ManifestError('manifest is shorter than its header');
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ManifestError('header magic mismatch');
  }

  const version = readUInt32(buffer, 16, 'version');
  if (version !== VERSION) {
    throw new ManifestError(`unsupported manifest version ${version} (expected ${VERSION})`);
  }

  const length = readUInt32(buffer, 20, 'length');
  if (length !== buffer.length) {
    throw new ManifestError(`length mismatch: header says ${length}, file is ${buffer.length}`);
  }

  const storedCrc = readUInt32(buffer, CRC_OFFSET, 'crc32');
  const computedCrc = crcOfManifest(buffer);
  if (storedCrc !== computedCrc) {
    throw new ManifestError(
      `crc mismatch: stored 0x${storedCrc.toString(16)}, computed 0x${computedCrc.toString(16)}`
    );
  }

  const entryCount = readUInt32(buffer, 28, 'entryCount');
  const entryFields = readUInt32(buffer, 32, 'entryFields');
  if (entryFields < ENTRY_FIELDS) {
    throw new ManifestError(`entryFields ${entryFields} is smaller than ${ENTRY_FIELDS}`);
  }

  const buildCL = readUInt32(buffer, 36, 'buildCL');
  const resourceHash = readUInt32(buffer, 40, 'resourceHash');

  const tableStart = HEADER_SIZE;
  const tableEnd = tableStart + entryCount * entryFields * 4;
  if (tableEnd > buffer.length) {
    throw new ManifestError('entry table runs past the end of the manifest');
  }

  const entries = new Array(entryCount);
  for (let i = 0; i < entryCount; i++) {
    const row = tableStart + i * entryFields * 4;
    entries[i] = {
      timestamp: buffer.readUInt32LE(row),
      compressedSize: buffer.readUInt32LE(row + 4),
      category: readCString(buffer, buffer.readUInt32LE(row + 8), `entry ${i} category`),
      name: readCString(buffer, buffer.readUInt32LE(row + 12), `entry ${i} name`),
      hash: readHash(buffer, buffer.readUInt32LE(row + 16), `entry ${i} pathHash`),
      size: buffer.readUInt32LE(row + 20),
      type: buffer.readUInt32LE(row + 24),
    };
  }

  return { version, length, crc32: storedCrc, entryCount, entryFields, buildCL, resourceHash, entries, buffer };
}

/**
 * Serialise a manifest. `resourceHash` may be omitted to derive one from the
 * entry table, which changes whenever the entry set changes.
 */
function buildManifest(rawEntries, options = {}) {
  if (!Array.isArray(rawEntries)) throw new ManifestError('entries must be an array');
  const entries = rawEntries.map(normalizeEntry);

  const payloadStart = HEADER_SIZE + entries.length * ENTRY_SIZE;
  const layouts = new Array(entries.length);
  let payloadSize = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const category = Buffer.from(`${entry.category}\0`, 'utf8');
    const name = Buffer.from(`${entry.name}\0`, 'utf8');
    layouts[i] = { category, name, offsets: { category: payloadSize, name: payloadSize + category.length } };
    payloadSize += category.length + name.length + PAYLOAD_HASH_LENGTH;
  }

  const totalSize = payloadStart + payloadSize;
  const table = Buffer.alloc(entries.length * ENTRY_SIZE);
  const payload = Buffer.alloc(payloadSize);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const layout = layouts[i];
    const row = i * ENTRY_SIZE;

    layout.category.copy(payload, layout.offsets.category);
    layout.name.copy(payload, layout.offsets.name);
    entry.hash.copy(payload, layout.offsets.name + layout.name.length);

    table.writeUInt32LE(entry.timestamp, row);
    table.writeUInt32LE(entry.compressedSize, row + 4);
    table.writeUInt32LE(payloadStart + layout.offsets.category, row + 8);
    table.writeUInt32LE(payloadStart + layout.offsets.name, row + 12);
    table.writeUInt32LE(
      payloadStart + layout.offsets.name + layout.name.length,
      row + 16
    );
    table.writeUInt32LE(entry.size, row + 20);
    table.writeUInt32LE(entry.type, row + 24);
  }

  const resourceHash = Number.isFinite(Number(options.resourceHash)) && Number(options.resourceHash) !== 0
    ? Number(options.resourceHash) >>> 0
    : crc32(Buffer.concat([table, payload]));
  const buildCL = Number(options.buildCL ?? 0) >>> 0;

  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(VERSION, 16);
  header.writeUInt32LE(totalSize, 20);
  header.writeUInt32LE(0, CRC_OFFSET);
  header.writeUInt32LE(entries.length, 28);
  header.writeUInt32LE(ENTRY_FIELDS, 32);
  header.writeUInt32LE(buildCL, 36);
  header.writeUInt32LE(resourceHash, 40);

  const file = Buffer.concat([header, table, payload]);
  file.writeUInt32LE(crcOfManifest(file), CRC_OFFSET);
  return file;
}

function manifestSummary(manifest) {
  return {
    version: manifest.version,
    bytes: manifest.length,
    entryCount: manifest.entryCount,
    entryFields: manifest.entryFields,
    buildCL: manifest.buildCL,
    resourceHash: `R${manifest.resourceHash.toString(16).padStart(8, '0')}`,
    crc32: `0x${manifest.crc32.toString(16).padStart(8, '0')}`,
  };
}

module.exports = {
  MAGIC,
  VERSION,
  HEADER_SIZE,
  ENTRY_FIELDS,
  ENTRY_SIZE,
  CRC_OFFSET,
  ManifestError,
  crc32,
  parseManifest,
  buildManifest,
  manifestSummary,
  normalizeHash,
};
