import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { config } from './config.js';
import { auctionService } from './auction/service.js';
import { AuctionError } from './auction/engine.js';
import { createSocketServer } from './sockets.js';
import { getSettingsDoc } from './settings.js';
import { decryptJson } from './lib/crypto.js';
import { configureStorage, storageMode } from './integrations/storage.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import captainRoutes from './routes/captain.js';
import adminRoutes from './routes/admin.js';

async function main() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { maxPoolSize: 20 });
  console.log('MongoDB connected');

  const settings = await getSettingsDoc();
  try {
    configureStorage(decryptJson(settings.integrations?.r2Enc));
  } catch (err) {
    console.error('Could not decrypt stored R2 credentials (was MASTER_KEY changed?)', err.message);
  }
  console.log(`Image storage: ${storageMode()}`);

  await auctionService.init();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.corsOrigins, maxAge: 600 }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (req, res) => res.json({
    ok: true,
    db: mongoose.connection.readyState === 1,
    auction: auctionService.engine.state.status,
    storage: storageMode(),
    serverNow: Date.now(),
  }));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/captain', captainRoutes);
  app.use('/api', publicRoutes);

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || (err instanceof AuctionError ? 409 : 500);
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Something went wrong on the server' : err.message;
    res.status(status).json({ error: err.code && status < 500 ? err.code : 'ERROR', message, ...(err.details ? { details: err.details } : {}) });
  });

  const server = http.createServer(app);
  const io = createSocketServer(server, auctionService, config.corsOrigins);
  auctionService.attach(io);

  server.listen(config.port, () => console.log(`API listening on :${config.port}`));

  const shutdown = async (signal) => {
    console.log(`${signal} received, saving and shutting down`);
    server.close();
    io.close();
    await auctionService.drain().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
