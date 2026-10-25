import express from 'express';
import mongoose from 'mongoose';
import { createAuthRouter } from './auth/routes.js';
import { createBooksRouter } from './books/routes.js';
import { createTicketsRouter } from './tickets/routes.js';

import { httpConfiguration, configureHttp, httpSecurity } from './config/http-security.js';

const app = express();
configureHttp(app,httpConfiguration({}));
app.use(httpSecurity);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// Report readiness from the current connection state, not process liveness alone.
app.get('/api/health', (_req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', service: 'bookleaf-api', database: ready ? 'connected' : 'disconnected' });
});

app.use('/api', createAuthRouter());
app.use('/api', createBooksRouter());
app.use('/api', createTicketsRouter());

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, _req, res, _next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500
    ? err.status
    : 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : 'Invalid request',
  });
});

export default app;
