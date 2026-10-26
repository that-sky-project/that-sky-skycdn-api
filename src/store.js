'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildManifest, parseManifest, manifestSummary } = require('./manifest');

const HASH_RE = /^[0-9a-f]{40}$/;
const PLATFORM_RE = /^[a-z0-9_-]{1,32}$/;

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
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) {
    logger.warn(`base manifest not found: ${filePath} (serving overlay entries only)`);
    return null;
  }
  try {
    return parseManifest(fs.readFileSync(filePath));
  } catch (error) {
    logger.error('Failed to parse base manifest', filePath, error.message);
    throw error;
  }
}

/**
 * Split `<platform>/<category>/<name>` into a manifest entry identity. The
 * first path segment is treated as the asset category only when it is a known
 * one; otherwise the whole relative path becomes the name under defaultCategory.
 */
function classify(relPath, categories, defaultCategory) {
  const segments = relPath.split('/');
  const first = segments[0];
  if (segments.length > 1 && categories.has(first)) {
    return { category: first, name: segments.slice(1).join('/') };
  }
  return { category: defaultCategory, name: relPath };
}

function scanOverlay(root, categories, config, logger) {
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
      // The client only creates download actions for entries whose `type` is 2.
      type: 2,
      filePath: file.abs,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  logger.info(`Scanned ${entries.length} overlay file(s)`, root);
  return entries;
}

/** `<base>/<platform>/resource.manifest`; legacy single-file layouts still work. */
function baseFileFor(config, platform) {
  const root = config.manifest.base;
  if (!root) return '';
  const defaultPlatform = normalizePlatform(config.manifest.defaultPlatform) || 'win';
  if (fs.existsSync(root) && fs.statSync(root).isFile()) {
    return platform === defaultPlatform ? root : '';
  }
  return path.join(root, platform, 'resource.manifest');
}

/**
 * Overlay content is shared by every platform; only the ROM baseline differs.
 * `<manifest.content>/<category>/<name>`
 */
function contentRoot(config) {
  const root = config.manifest.content;
  return root && fs.existsSync(root) ? root : '';
}

function normalizePlatform(value) {
  const text = String(value || '').trim().toLowerCase();
  return PLATFORM_RE.test(text) ? text : '';
}

function discoverPlatforms(config, logger) {
  const found = new Set();
  const fallback = normalizePlatform(config.manifest.defaultPlatform) || 'win';
  found.add(fallback);
  for (const value of config.manifest.platforms || []) {
    const platform = normalizePlatform(value);
    if (platform) found.add(platform);
    else logger.warn('Ignoring invalid manifest platform name', value);
  }

  const root = config.manifest.base;
  if (root && fs.existsSync(root) && fs.statSync(root).isDirectory()) {
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      if (fs.existsSync(path.join(root, item.name, 'resource.manifest'))) {
        const platform = normalizePlatform(item.name);
        if (platform) found.add(platform);
      }
    }
  }

  return [...found];
}

function buildPlatformStore(config, platform, base, overlay, contentRootValue, logger) {
  // Merge by name: the client indexes entries by FNV-1a(name), so a name must
  // resolve to exactly one entry. Overlay entries replace base entries.
  const byName = new Map();
  if (base) for (const entry of base.entries) byName.set(entry.name, entry);
  for (const entry of overlay) byName.set(entry.name, entry);
  const entries = Array.from(byName.values());

  // The client downloads every type=2 entry. Base entries we cannot serve
  // must be downgraded to 0, otherwise every sync logs a 404.
  const overlayHashes = new Set(overlay.map((entry) => entry.hash.toString('hex')));
  for (const entry of entries) {
    if (entry.type !== 2) continue;
    if (overlayHashes.has(entry.hash.toString('hex'))) continue;
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

  // Boot-time definitions first, so an interrupted sync still leaves a
  // bootable cache instead of asserting in Vfs.cpp.
  const rank = (entry) =>
    (entry.type === 2 ? 0 : 10) + (entry.name.startsWith('Data/Resources/') ? 0 : 1);
  entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const buildCL =
    config.manifest.buildCL > 0
      ? config.manifest.buildCL
      : base
        ? (base.buildCL + 1) >>> 0
        : 1;

  const manifestBuffer = buildManifest(entries, {
    buildCL,
    resourceHash: config.manifest.resourceHash || 0,
  });
  const manifest = parseManifest(manifestBuffer);

  const overlayByHash = new Map();
  for (const entry of overlay) overlayByHash.set(entry.hash.toString('hex'), entry.filePath);

  const baseByHash = new Map();
  if (base) {
    for (const entry of base.entries) {
      const key = entry.hash.toString('hex');
      if (!baseByHash.has(key)) baseByHash.set(key, entry);
    }
  }

  const assetsDir = config.assets.dir;
  function resolve(hash) {
    const key = String(hash || '').toLowerCase();
    if (!HASH_RE.test(key)) return null;

    const overlayPath = overlayByHash.get(key);
    if (overlayPath) return overlayPath;

    if (assetsDir) {
      const entry = baseByHash.get(key);
      if (entry) {
        const candidate = path.resolve(assetsDir, entry.category, entry.name);
        if (candidate.startsWith(path.resolve(assetsDir) + path.sep) && fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }

  const summary = manifestSummary(manifest);
  logger.info(
    'Manifest ready',
    `platform=${platform}`,
    JSON.stringify({
      ...summary,
      entries: entries.length,
      baseEntries: base ? base.entries.length : 0,
      overlayEntries: overlay.length,
      content: contentRootValue || null,
    })
  );

  return {
    platform,
    manifest,
    manifestBuffer,
    summary,
    entries,
    overlay,
    base,
    contentRoot: contentRootValue,
    resolve,
  };
}

/**
 * Build one manifest per platform.
 *
 *   <manifest.base>/<platform>/resource.manifest   ROM baseline
 *   <manifest.content>/<platform>/<category>/<name> overlay
 *
 * `POST /manifest` picks the platform from the resource token claim; the
 * default platform is used when the token has none (older game servers) or an
 * unknown one.
 */
function createStores(config, logger) {
  const platforms = discoverPlatforms(config, logger);
  const categories = new Set(
    (config.manifest.categories || []).map((value) => String(value).trim()).filter(Boolean)
  );

  const bases = new Map();
  for (const platform of platforms) {
    const file = baseFileFor(config, platform);
    if (file) {
      const base = readBaseManifest(file, logger);
      bases.set(platform, base);
      if (base) {
        for (const entry of base.entries) categories.add(entry.category);
        logger.info('Loaded base manifest', platform, file, JSON.stringify(manifestSummary(base)));
      }
    }
  }

  // Categories from every base manifest are needed before scanning the shared
  // overlay, so the build is split into two passes.
  const root = contentRoot(config);
  const overlay = scanOverlay(root, categories, config, logger);

  const stores = new Map();
  for (const platform of platforms) {
    stores.set(
      platform,
      buildPlatformStore(config, platform, bases.get(platform) || null, overlay, root, logger)
    );
  }

  const configuredDefault = normalizePlatform(config.manifest.defaultPlatform) || 'win';
  const defaultPlatform = stores.has(configuredDefault)
    ? configuredDefault
    : stores.keys().next().value;

  const missingWarned = new Set();
  function warnMissing(hash) {
    if (missingWarned.has(hash)) return;
    missingWarned.add(hash);
    logger.warn('Resource not available on this CDN', hash);
  }

  function get(platform) {
    return stores.get(normalizePlatform(platform)) || stores.get(defaultPlatform);
  }

  function resolve(hash) {
    for (const store of stores.values()) {
      const file = store.resolve(hash);
      if (file) return file;
    }
    return null;
  }

  return {
    platforms,
    stores,
    defaultPlatform,
    get,
    has(platform) {
      return stores.has(normalizePlatform(platform));
    },
    resolve,
    warnMissing,
  };
}

/** Backwards-compatible single-store helper (used by tests/tools). */
function createStore(config, logger) {
  return createStores(config, logger).get();
}

module.exports = {
  createStores,
  createStore,
  classify,
  walkFiles,
  normalizePlatform,
  HASH_RE,
};
