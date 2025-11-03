import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import serviceCalendarRoutes from './routes/service-calendar.routes';
import { logger } from './middlewares/logger';
import { rateLimit } from './middlewares/rateLimit';
import { config } from './config/config';

const app = new Hono();

// CORS middleware
const corsOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
  : ['*'];

app.use('*', cors({
  origin: corsOrigins,
  allowHeaders: ['Content-Type', 'Authorization', 'x-access-token', 'x-refresh-token'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge: 600,
  credentials: true,
}));

// Logger middleware (dev)
app.use('*', logger());

// Rate limiting middleware (requires Redis)
// TEMPORARILY DISABLED - causing body parsing issues in Vercel
// if (config.rateLimit.enabled) {
//   console.log('Rate limiting enabled');
//   app.use('/api/*', rateLimit({
//     windowMs: config.rateLimit.windowMs,
//     maxRequests: config.rateLimit.maxRequests
//   }));
// } else {
//   console.log('Rate limiting disabled');
// }
console.log('⚠️  Rate limiting DISABLED to fix body parsing timeout');

// Health check
app.get('/', (c) => {
  return c.json({ 
    ok: true, 
    service: 'hono-google-calendar',
    version: '0.1.1',
    timestamp: new Date().toISOString()
  });
});

// Mount routes
app.route('/api', serviceCalendarRoutes);

// OpenAPI documentation endpoint (serve the JSON file)
app.get('/doc', (c) => {
  const openApiSpec = require('./openapi.json');
  return c.json(openApiSpec);
});

// Swagger UI endpoint
app.get('/swagger', swaggerUI({ url: '/doc' }));

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ 
    error: 'Internal Server Error', 
    message: err.message 
  }, 500);
});

export default app;
