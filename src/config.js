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
    prefix: z.string().default(''),
    tokenSecret: z.string().default(''),
    tokenTtlSeconds: z.coerce.number().int().min(60).max(604800).default(86400),
    env: z.string().default('Beta'),
    requirePrefix: z.boolean().default(false),
    apiKey: z.string().default(''),
  }).prefault({}),
  manifest: z.looseObject({
    base: z.string().default(''),
    content: z.string().default('./content'),
    defaultCategory: z.string().default('initial'),
    categories: z.array(z.string()).default([]),
    buildCL: z.coerce.number().int().min(0).default(0),
    resourceHash: z.coerce.number().int().min(0).default(0),
    output: z.string().default('./data/manifests/default/resource.manifest'),
  }).prefault({}),
  assets: z.looseObject({
    dir: z.string().default(''),
  }).prefault({}),
  logging: z.looseObject({
    level: z.string().default('info'),
  }).prefault({}),
});

const ROOT = path.resolve(__dirname, '..');

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
  config.manifest.base = resolvePath(config.manifest.base);
  config.manifest.content = resolvePath(config.manifest.content, './content');
  config.manifest.output = resolvePath(config.manifest.output, './data/manifests/default/resource.manifest');
  config.assets.dir = resolvePath(config.assets.dir);
  return config;
}

module.exports = { loadConfig, configSchema, ROOT };
