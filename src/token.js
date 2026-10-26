'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/**
 * Two separate credentials:
 *
 *  - `cdn.apiKey` authenticates the game server on the control plane
 *    (POST /token). Both sides hold the same value.
 *  - `cdn.tokenSecret` signs the per-player resource token this service issues
 *    and verifies on the data plane (/manifest, /resources/*). It never leaves
 *    this service.
 *
 * The client never inspects the resource token — it just forwards it as
 * `Authentication: Bearer <token>`.
 */

function extractionToken(req) {
  // The client sends the non-standard `Authentication` header; accept the
  // standard one too so curl/nginx tests are easy.
  const header = req.get('authentication') || req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const PLATFORM_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * The game server extracts the platform from the client User-Agent
 * (`com.tgc.sky.win` -> `win`, `com.tgc.sky.android` -> `android`). Unknown or
 * empty values are dropped instead of rejecting the login.
 */
function normalizePlatform(value) {
  const text = String(value || '').trim().toLowerCase();
  return PLATFORM_RE.test(text) ? text : '';
}

function issueResourceToken(config, userId, { platform } = {}) {
  const secret = config.cdn.tokenSecret;
  if (!secret) throw new Error('cdn.tokenSecret is not configured');
  const ttl = Number(config.cdn.tokenTtlSeconds || 3600);
  const normalizedPlatform = normalizePlatform(platform);
  const claims = {
    env: config.cdn.env || 'Beta',
    purpose: ['resources'],
    sub: userId,
  };
  if (normalizedPlatform) claims.platform = normalizedPlatform;
  const token = jwt.sign(claims, secret, { expiresIn: ttl, algorithm: 'HS256' });
  return {
    token,
    expiresAt: Math.floor(Date.now() / 1000) + ttl,
    platform: normalizedPlatform,
  };
}

function createApiKeyAuth(config, logger) {
  const key = config.cdn.apiKey;
  if (!key) {
    logger.warn('cdn.apiKey is empty: the control endpoint accepts any caller');
    return (req, res, next) => next();
  }

  return (req, res, next) => {
    if (!safeEqual(req.get('x-api-key'), key)) {
      logger.warn('Rejected control request', req.ip, req.path);
      return res.status(401).json({ error: 'invalid_api_key' });
    }
    return next();
  };
}

function createTokenVerifier(config, logger) {
  const secret = config.cdn.tokenSecret;

  if (!secret) {
    logger.warn('cdn.tokenSecret is empty: accepting unauthenticated data requests');
    return (req, res, next) => next();
  }

  return (req, res, next) => {
    const token = extractionToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing_token' });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch (error) {
      logger.warn('Rejected resource token', req.ip, error.message);
      return res.status(401).json({ error: 'invalid_token' });
    }

    const purpose = payload.purpose;
    const allowed = Array.isArray(purpose)
      ? purpose.includes('resources')
      : purpose === 'resources';
    if (!allowed) {
      return res.status(403).json({ error: 'invalid_purpose' });
    }

    if (config.cdn.env && payload.env !== config.cdn.env) {
      return res.status(403).json({ error: 'invalid_env' });
    }

    req.cdnToken = payload;
    return next();
  };
}

module.exports = {
  issueResourceToken,
  createApiKeyAuth,
  createTokenVerifier,
  extractionToken,
  normalizePlatform,
};
