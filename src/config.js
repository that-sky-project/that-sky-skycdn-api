'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { z } = require('zod');

const configSchema = z.looseObject({
  server: z.looseObject({
    host: z.string().default('0.0.0.0'),
    port: z.coerce.number().int().min(1).max(65535).default(25570),
    tls: z.looseObject({
      enabled: z.boolean().default(false),
      cert: z.string().default('./data/ssl/fullchain.pem'),
      key: z.string().default('./data/ssl/privkey.pem'),
    }).prefault({}),
  }).prefault({}),
  cdn: z.looseObject({
    // Sent to the client as X-CDN-Prefix and used by the CDN for routing. The
    // public host is configured on the game server (cdn.host), not here.
    prefix: z.string().default(''),
    tokenSecret: z.string().default(''),
    tokenTtlSeconds: z.coerce.number().int().min(60).max(604800).default(86400),
    env: z.string().default('Beta'),
    requirePrefix: z.boolean().default(false),
    apiKey: z.string().default(''),
  }).prefault({}),
  manifest: z.looseObject({
    // Root containing one ROM baseline per platform:
    //   <base>/<platform>/resource.manifest
    // A legacy single file path is still accepted for the default platform.
    base: z.string().default('./data/base'),
    // Overlay content root, shared by every platform:
    //   <content>/<category>/<name>
    content: z.string().default('./content'),
    // Platform served when the token has no platform claim (older game
    // servers) or an unknown one.
    defaultPlatform: z.string().default('win'),
    // Extra platforms to load. Empty = discovered from <base>/<platform>/.
    platforms: z.array(z.string()).default([]),
    defaultCategory: z.string().default('initial'),
    categories: z.array(z.string()).default([]),
    buildCL: z.coerce.number().int().min(0).default(0),
    resourceHash: z.coerce.number().int().min(0).default(0),
    // Directory written by `npm run build` (one subdirectory per platform).
    output: z.string().default('./data/manifests'),
  }).prefault({}),
  assets: z.looseObject({
    // Default game `data/assets` tree used to serve base-manifest blobs.
    dir: z.string().default(''),
    // Optional per-platform overrides, e.g. { android: "/srv/android/data/assets" }.
    platforms: z.record(z.string(), z.string()).default({}),
  }).prefault({}),
  logging: z.looseObject({
    level: z.string().default('info'),
  }).prefault({}),
});

const ROOT = path.resolve(__dirname, '..');

// Relative paths in the YAML are relative to the service root, not to the
// process working directory, so `node src/app.js` and `node tools/build.js`
// behave the same.
function resolvePath(value, fallback) {
  const target = value || fallback;
  if (!target) return '';
  return path.isAbsolute(target) ? target : path.resolve(ROOT, target);
}

function loadConfig(filePath = path.join(ROOT, 'config', 'config.yml')) {
  let raw = {};
  if (fs.existsSync(filePath)) {
    raw = yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(`CDN config validation failed:\n${detail}`);
  }

  const config = result.data;
  config.server.tls.cert = resolvePath(config.server.tls.cert);
  config.server.tls.key = resolvePath(config.server.tls.key);
  config.manifest.base = resolvePath(config.manifest.base, './data/base');
  config.manifest.content = resolvePath(config.manifest.content, './content');
  config.manifest.output = resolvePath(config.manifest.output, './data/manifests');
  config.assets.dir = resolvePath(config.assets.dir);
  config.assets.platforms = Object.fromEntries(
    Object.entries(config.assets.platforms || {}).map(([platform, dir]) => [
      String(platform).trim().toLowerCase(),
      resolvePath(dir),
    ])
  );
  return config;
}

module.exports = { loadConfig, configSchema, ROOT };
