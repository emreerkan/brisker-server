import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0', // Listen on all interfaces for network access
  trustProxy: (process.env.TRUST_PROXY || 'false').toLowerCase() === 'true',
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 100),
};


