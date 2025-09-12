import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config.js';
import { WSManager } from './ws.js';

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(morgan('dev'));

// Rate limiting
app.use(rateLimit({ windowMs: config.rateLimitWindowMs, max: config.rateLimitMax }));

// Simple health
app.get('/health', (_req, res) => res.json({ ok: true }));

// No database-backed routes in the lightweight WebSocket-only server

let server = http.createServer(app);

// Create HTTPS server with self-signed certificate for development
/*let server;
try {
  // Try to use HTTPS with self-signed certificates
  const httpsOptions = {
    key: fs.readFileSync('localhost-key.pem', 'utf8'),
    cert: fs.readFileSync('localhost.pem', 'utf8')
  };
  server = https.createServer(httpsOptions, app);
  console.log('🔒 HTTPS server created with SSL certificates');
} catch (error) {
  console.log('⚠️  SSL certificates not found, falling back to HTTP server');
  console.log('💡 To enable HTTPS, run: mkcert localhost');
  server = http.createServer(app);
}*/

const ws = new WSManager(server);

// Error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Bad Request' });
});

server.listen(config.port, config.host, () => {
  const protocol = server instanceof https.Server ? 'https' : 'http';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  
  console.log(`🚀 Server listening on ${protocol}://localhost:${config.port}`);
  console.log(`🔌 WebSocket available at ${wsProtocol}://localhost:${config.port}`);
  
  // Show network access information
  if (config.host === '0.0.0.0') {
    console.log(`📡 Network access enabled - server accessible from other devices`);
    console.log(`💡 Find your local IP with: ifconfig | grep "inet " | grep -v 127.0.0.1`);
    
    if (server instanceof https.Server) {
      console.log(`⚠️  SSL Certificate Warning:`);
      console.log(`   Certificate is for 'localhost' only - IP access will show security warnings`);
      console.log(`   For secure IP access, recreate cert with: mkcert localhost 192.168.68.102`);
      console.log(`🌐 Network HTTPS: https://[YOUR_IP]:${config.port} (certificate warnings expected)`);
      console.log(`🔌 Network WSS: wss://[YOUR_IP]:${config.port} (certificate warnings expected)`);
    } else {
      console.log(`🌐 Network HTTP: http://[YOUR_IP]:${config.port}`);
      console.log(`🔌 Network WS: ws://[YOUR_IP]:${config.port}`);
    }
  }
});
