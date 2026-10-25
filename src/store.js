const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildManifest, parseManifest, manifestSummary } = require('./manifest');

const HASH_RE = /^[0-9a-f]{40}$/;

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest();
}

function walkFiles(dir, baseDir = dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const abs = path.join(dir, item.name);
    if (item.isDirectory()) walkFiles(abs, baseDir, out);
    else if (item.isFile()) out.push({ abs, rel: path.relative(baseDir, abs).split(path.sep).join('/') });
  }
  return out;
}

function readBaseManifest(filePath, logger) {
  if (!filePath) {
    logger.warn('manifest.base is not configured: only overlay entries will be served');
    return null;
  }
  if (!fs.existsSync(filePath)) {
    logger.warn(`manifest.base not found: ${filePath} (serving overlay entries only)`);
    return null;
  }
  try {
    const manifest = parseManifest(fs.readFileSync(filePath));
    logger.info('Loaded base manifest', filePath, JSON.stringify(manifestSummary(manifest)));
    return manifest;
  } catch (error) {
    logger.error('Failed to parse base manifest', filePath, error.message);
    throw error;
  }
}

/**
 * Split `content/<category>/<name>` into a manifest entry identity. The first
 * path segment is treated as the asset category only when it is a known one;
 * otherwise the whole relative path becomes the name under defaultCategory.
 */
function classify(relPath, categories, defaultCategory) {
  const segments = relPath.split('/');
  const first = segments[0];
  if (segments.length > 1 && categories.has(first)) {
    return { category: first, name: segments.slice(1).join('/') };
  }
  return { category: defaultCategory, name: relPath };
}

function scanOverlay(config, categories, logger) {
  const root = config.manifest.content;
  if (!root || !fs.existsSync(root)) {
    logger.info('No overlay content directory', root || '<unset>');
    return [];
  }

  const files = walkFiles(root);
  const entries = [];
  for (const file of files) {
    if (path.basename(file.rel).toLowerCase() === 'readme.md') continue;
    const identity = classify(file.rel, categories, config.manifest.defaultCategory);
    const body = fs.readFileSync(file.abs);
    entries.push({
      ...identity,
      hash: sha1(body),
      timestamp: Math.floor(fs.statSync(file.abs).mtimeMs / 1000),
      compressedSize: body.length,
      size: body.length,
      // The client only creates download actions for manifest entries whose
      // `type` field is 2 (official ROM entries are 0 except build_number.txt).
      // Overlay entries must be 2 or the client reports "manifests not
      // different" and downloads nothing.
      type: 2,
      // Kept only in memory so the HTTP layer can stream the exact bytes.
      filePath: file.abs,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  logger.info(`Scanned ${entries.length} overlay file(s)`, root);
  return entries;
}

function createStore(config, logger) {
  const base = readBaseManifest(config.manifest.base, logger);

  const categories = new Set(config.manifest.categories.map((value) => String(value).trim()).filter(Boolean));
  if (base) for (const entry of base.entries) categories.add(entry.category);

  const overlay = scanOverlay(config, categories, logger);

  // Merge by name: the client indexes entries by FNV-1a(name), so a name must
  // resolve to exactly one entry. Overlay entries replace base entries.
  const byName = new Map();
  if (base) {
    for (const entry of base.entries) byName.set(entry.name, entry);
  }
  for (const entry of overlay) byName.set(entry.name, entry);

  const entries = Array.from(byName.values());

  // The client downloads every type=2 entry. Base entries we cannot serve
  // (e.g. Data/Debug/build_number.txt when assets.dir is not mounted inside
  // the container) must be downgraded to 0, otherwise every sync logs a 404.
  const overlayHashes = new Set(overlay.map((entry) => entry.hash.toString('hex')));
  for (const entry of entries) {
    if (entry.type !== 2) continue;
    const key = entry.hash.toString('hex');
    if (overlayHashes.has(key)) continue;
    if (config.assets.dir) {
      const candidate = path.resolve(config.assets.dir, entry.category, entry.name);
      if (
        candidate.startsWith(path.resolve(config.assets.dir) + path.sep) &&
        fs.existsSync(candidate)
      ) {
        continue;
      }
    }
    entry.type = 0;
  }

  // The client writes the new manifest *before* downloading anything, and the
  // boot-time definitions (Data/Resources/*.lua|json) are loaded before login.
  // Put syncable definitions first, then syncable assets, so an interrupted
  // sync still leaves a bootable cache instead of asserting in Vfs.cpp with
  // "Failed opening file MeshDefs.lua".
  const rank = (entry) =>
    (entry.type === 2 ? 0 : 10) + (entry.name.startsWith('Data/Resources/') ? 0 : 1);
  entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const buildCL = config.manifest.buildCL > 0
    ? config.manifest.buildCL
    : (base ? (base.buildCL + 1) >>> 0 : 1);

  const manifestBuffer = buildManifest(entries, {
    buildCL,
    resourceHash: config.manifest.resourceHash || 0,
  });
  const manifest = parseManifest(manifestBuffer);

  // hash -> overlay file path (content-addressed; duplicates collapse).
  const overlayByHash = new Map();
  for (const entry of overlay) overlayByHash.set(entry.hash.toString('hex'), entry.filePath);

  // hash -> identity, for serving original game files when assets.dir is set.
  const baseByHash = new Map();
  if (base) {
    for (const entry of base.entries) {
      const key = entry.hash.toString('hex');
      if (!baseByHash.has(key)) baseByHash.set(key, entry);
    }
  }

  const assetsDir = config.assets.dir;
  const missingWarned = new Set();

  function resolve(hash) {
    const key = String(hash || '').toLowerCase();
    if (!HASH_RE.test(key)) return null;

    const overlayPath = overlayByHash.get(key);
    if (overlayPath) return overlayPath;

    if (assetsDir) {
      const entry = baseByHash.get(key);
      if (entry) {
        const candidate = path.resolve(assetsDir, entry.category, entry.name);
        // Defence in depth: never let a crafted manifest name escape assets.dir.
        if (candidate.startsWith(path.resolve(assetsDir) + path.sep) && fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  function warnMissing(hash) {
    if (missingWarned.has(hash)) return;
    missingWarned.add(hash);
    const known = baseByHash.get(hash);
    logger.warn(
      'Resource not available on this CDN',
      hash,
      known ? `${known.category}/${known.name}` : '(unknown entry)'
    );
  }

  const summary = manifestSummary(manifest);
  logger.info('Manifest ready', JSON.stringify({
    ...summary,
    entries: entries.length,
    baseEntries: base ? base.entries.length : 0,
    overlayEntries: overlay.length,
    assetsDir: assetsDir || null,
  }));

  return {
    manifest,
    manifestBuffer,
    summary,
    entries,
    overlay,
    base,
    resolve,
    warnMissing,
  };
}

module.exports = { createStore, classify, walkFiles, HASH_RE };
