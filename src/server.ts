import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { startEmailWorker, stopEmailWorker } from './services/emailWorker.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { logError, logInfo } from './utils/logger.js';
import authRoutes from './routes/auth.js';
import driveRoutes from './routes/drive.js';
import paypalRoutes from './routes/paypal.js';
import razorpayRoutes from './routes/razorpay.js';
import dashboardRoutes from './routes/dashboard.js';

const app = express();
let server: import('node:http').Server | null = null;
let shuttingDown = false;

app.disable('x-powered-by');
app.set('trust proxy', config.server.trustProxy.enabled ? config.server.trustProxy.level : false);
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(cors({ origin: config.server.corsOrigins, credentials: true }));
app.use(morgan('combined'));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: config.app.name, env: config.app.env, time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/integrations/drive', driveRoutes);
app.use('/api/integrations/paypal', paypalRoutes);
app.use('/api/integrations/razorpay', razorpayRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Static UI
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

app.get('/api/*', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// SPA-style page fallback: serve matching html file if present
app.get('*', (req, res, next) => {
  const pageMap: Record<string, string> = {
    '/': 'index.html',
    '/login': 'login.html',
    '/signup': 'signup.html',
    '/clerk-login': 'clerk-login.html',
    '/verify-email': 'verify-email.html',
    '/forgot-password': 'forgot-password.html',
    '/reset-password': 'reset-password.html',
    '/dashboard': 'dashboard.html',
  };
  const file = pageMap[req.path];
  if (file) {
    res.sendFile(path.join(publicDir, file));
    return;
  }
  next();
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError('Unhandled request error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

async function start(): Promise<void> {
  await runMigrations();
  startEmailWorker();
  startScheduler();
  server = app.listen(config.server.port, config.server.host, () => {
    logInfo(`${config.app.name} listening`, { host: config.server.host, port: config.server.port, url: `http://${config.server.host}:${config.server.port}` });
  });
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo(`Received ${signal}, shutting down gracefully`);

  await stopScheduler();
  await stopEmailWorker();

  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      setTimeout(() => resolve(), 10000).unref();
    });
    server = null;
  }
  try {
    await closePool();
  } catch (err) {
    logError('Error closing db pool', { error: err instanceof Error ? err.message : String(err) });
  }
  logInfo('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logError('Unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});

start().catch((err) => {
  logError('Failed to start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
