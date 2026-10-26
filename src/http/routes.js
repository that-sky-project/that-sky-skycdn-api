'use strict';

const express = require('express');
const { createTokenVerifier, createApiKeyAuth, issueResourceToken, normalizePlatform } = require('../token');
const { HASH_RE, normalizePlatform: normalizeStorePlatform } = require('../store');

function requestLogger(logger) {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const token = req.cdnToken;
      logger.info(
        'request',
        `${req.method} ${req.originalUrl}`,
        `status=${res.statusCode}`,
        `ms=${elapsedMs.toFixed(1)}`,
        `ip=${req.ip}`,
        `prefix=${req.get('x-cdn-prefix') || ''}`,
        `platform=${token?.platform || '-'}`,
        `sub=${token?.sub || '-'}`
      );
    });
    next();
  };
}

function createRoutes({ config, stores, logger }) {
  const router = express.Router();
  const verifyToken = createTokenVerifier(config, logger);
  const verifyApiKey = createApiKeyAuth(config, logger);
  const defaultStore = stores.get(stores.defaultPlatform);
  const unknownPlatforms = new Set();

  // Optional hard requirement on the environment prefix advertised by the game
  // server. Off by default; the header is still logged.
  function checkPrefix(req, res, next) {
    if (!config.cdn.requirePrefix) return next();
    const expected = config.cdn.prefix;
    if ((req.get('x-cdn-prefix') || '') !== expected) {
      return res.status(403).json({ error: 'invalid_prefix' });
    }
    return next();
  }

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      ...defaultStore.summary,
      entries: defaultStore.entries.length,
      overlayEntries: defaultStore.overlay.length,
      baseEntries: defaultStore.base ? defaultStore.base.entries.length : 0,
      defaultPlatform: stores.defaultPlatform,
      platforms: Object.fromEntries(
        [...stores.stores].map(([platform, store]) => [
          platform,
          {
            ...store.summary,
            entries: store.entries.length,
            overlayEntries: store.overlay.length,
            baseEntries: store.base ? store.base.entries.length : 0,
          },
        ])
      ),
    });
  });

  // Control plane: the game server exchanges its api key for a per-player
  // resource token, then returns host/prefix/token to the client verbatim.
  router.post('/token', verifyApiKey, (req, res) => {
    const userId = String(req.body?.user_id || '').trim();
    if (!userId || userId.length > 100) {
      return res.status(400).json({ error: 'invalid_user_id' });
    }
    // Extracted from the client User-Agent by the game server. Unknown values
    // are dropped rather than failing the login.
    const platform = normalizePlatform(req.body?.platform);

    let issued;
    try {
      issued = issueResourceToken(config, userId, { platform });
    } catch (error) {
      logger.error('Failed to issue resource token', error.message);
      return res.status(500).json({ error: 'token_unavailable' });
    }

    logger.info(
      'Issued resource token',
      `sub=${userId}`,
      `platform=${issued.platform || '-'}`,
      `exp=${issued.expiresAt}`
    );
    return res.json({
      token: issued.token,
      expires_at: issued.expiresAt,
      platform: issued.platform,
    });
  });

  // The 0.35.1 client uses POST for /manifest and GET for /resources/<sha1>.
  // Both methods are accepted on both endpoints for curl/browser debugging.
  function handleManifest(req, res) {
    const requested = normalizeStorePlatform(req.cdnToken?.platform);
    const store = stores.get(requested);
    if (requested && !stores.has(requested) && !unknownPlatforms.has(requested)) {
      unknownPlatforms.add(requested);
      logger.warn('Unknown platform, serving the default manifest', requested, stores.defaultPlatform);
    }

    const { buildCL, resourceHash, length } = store.manifest;
    const etag = `"${store.platform}-m${buildCL}-${resourceHash.toString(16)}-${length}"`;
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('ETag', etag);
    res.set('X-CDN-Platform', store.platform);

    if ((req.get('if-none-match') || '') === etag) {
      return res.status(304).end();
    }
    return res.send(store.manifestBuffer);
  }

  function handleResource(req, res) {
    const hash = String(req.params.hash || '').toLowerCase();
    if (!HASH_RE.test(hash)) {
      return res.status(404).json({ error: 'not_found' });
    }

    const filePath = stores.resolve(hash);
    if (!filePath) {
      stores.warnMissing(hash);
      return res.status(404).json({ error: 'not_found' });
    }

    return res.sendFile(
      filePath,
      {
        headers: { 'Content-Type': 'application/octet-stream' },
        etag: true,
        lastModified: true,
        cacheControl: false,
      },
      (error) => {
        if (!error) return;
        if (error.code === 'ENOENT') {
          stores.warnMissing(hash);
          if (!res.headersSent) res.status(404).json({ error: 'not_found' });
          return;
        }
        logger.error('Failed to send resource', hash, filePath, error.message);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      }
    );
  }

  for (const method of ['get', 'post']) {
    router[method]('/manifest', verifyToken, checkPrefix, handleManifest);
    router[method]('/resources/:hash', verifyToken, checkPrefix, handleResource);
  }

  router.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, next) => {
    logger.error('Unhandled request error', req.originalUrl, error.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return router;
}

module.exports = { createRoutes, requestLogger };
