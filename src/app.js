'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createStores } = require('./store');
const { createRoutes, requestLogger } = require('./http/routes');

function createApp(options = {}) {
  const config = options.config || loadConfig();
  const logger = options.logger || createLogger(config.logging.level);
  const stores = options.stores || createStores(config, logger);

  const app = express();
  app.disable('x-powered-by');
  // The service normally sits behind nginx/caddy; req.ip is only used for logs.
  app.set('trust proxy', true);
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '16kb' }));
  app.use(createRoutes({ config, stores, logger }));

  // Body-parser errors happen before the router, so they need an app-level
  // handler as well; otherwise Express returns an HTML stack trace.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    logger.warn('Rejected request', req.originalUrl, error.message);
    if (!res.headersSent) res.status(400).json({ error: 'bad_request' });
  });

  return { app, config, stores, store: stores.get(stores.defaultPlatform), logger };
}

function createServer(app, config) {
  const tls = config.server.tls;
  if (!tls.enabled) return http.createServer(app);

  return https.createServer(
    {
      cert: fs.readFileSync(tls.cert),
      key: fs.readFileSync(tls.key),
    },
    app
  );
}

async function start() {
  const { app, config, stores, store, logger } = createApp();
  const server = createServer(app, config);
  const scheme = config.server.tls.enabled ? 'https' : 'http';

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, resolve);
  });

  logger.info(
    `Resource CDN API listening on ${scheme}://${config.server.host}:${config.server.port}`,
    `platforms=${stores.platforms.join(',')}`,
    `default=${stores.defaultPlatform}`,
    `buildCL=${store.manifest.buildCL}`,
    `resourceHash=R${store.manifest.resourceHash.toString(16)}`,
    `entries=${store.entries.length}`,
    `overlay=${store.overlay.length}`,
    `auth=${config.cdn.tokenSecret ? 'token' : 'open'}`,
    `apiKey=${config.cdn.apiKey ? 'set' : 'open'}`
  );

  if (!config.cdn.tokenSecret) {
    logger.warn('cdn.tokenSecret is empty: POST /token cannot issue tokens');
  }

  const shutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  start().catch((error) => {
    createLogger('error').error('Startup failed', error.message);
    process.exit(1);
  });
}

module.exports = { createApp, start };
