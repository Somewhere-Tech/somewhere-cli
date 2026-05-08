import http from 'node:http';
import open from 'open';
import chalk from 'chalk';
import type { CliConfig } from '../types.js';
import { getDeviceKeyName } from './device.js';

const AUTH_URL = 'https://api.somewhere.tech/v1/auth/cli';

/**
 * Browser-based OAuth login flow:
 * 1. Start local HTTP server on a random port
 * 2. Open browser to api.somewhere.tech/v1/auth/cli?redirect=http://localhost:PORT/callback
 * 3. User authenticates via Google OAuth
 * 4. Platform redirects to localhost with ?token=smt_...&email=...&username=...
 * 5. Return the received credentials
 *
 * If the browser doesn't open, prints the URL so the user can copy-paste it.
 */
export async function browserLogin(): Promise<CliConfig> {
  return new Promise<CliConfig>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);

      if (url.pathname === '/callback') {
        const token = url.searchParams.get('token');
        const email = url.searchParams.get('email') ?? '';
        const username = url.searchParams.get('username') ?? '';

        if (!token) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Authentication failed</h1><p>No token received. Close this tab and try again.</p>');
          reject(new Error('No token in callback'));
          server.close();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>somewhere.tech — Logged in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0d0e14;
      color: #e5e7eb;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      overflow: hidden;
    }
    .glow {
      position: fixed;
      top: 30%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 500px;
      height: 500px;
      background: radial-gradient(circle, rgba(45,212,191,0.08) 0%, transparent 70%);
      pointer-events: none;
    }
    .card {
      position: relative;
      z-index: 1;
      text-align: center;
      padding: 48px;
    }
    .brand {
      font-family: 'Instrument Serif', serif;
      font-style: italic;
      font-size: 28px;
      color: #2dd4bf;
      margin-bottom: 32px;
    }
    .check {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: rgba(45,212,191,0.1);
      border: 2px solid #2dd4bf;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 28px;
      color: #2dd4bf;
    }
    h1 {
      font-size: 22px;
      font-weight: 500;
      margin-bottom: 8px;
    }
    .sub {
      color: #6b7280;
      font-size: 14px;
      line-height: 1.6;
    }
    .email {
      color: #9ca3af;
      font-family: ui-monospace, monospace;
      font-size: 13px;
      margin-top: 24px;
      padding: 8px 16px;
      background: rgba(255,255,255,0.04);
      border-radius: 6px;
      display: inline-block;
    }
  </style>
</head>
<body>
  <div class="glow"></div>
  <div class="card">
    <div class="brand">somewhere.tech</div>
    <div class="check">✓</div>
    <h1>You're logged in</h1>
    <p class="sub">Return to your terminal. This tab can be closed.</p>
    <div class="email">${email}</div>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`);

        resolve({
          token,
          user: { email, username },
        });

        setTimeout(() => server.close(), 500);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to start local server'));
        return;
      }
      const port = addr.port;
      const redirect = `http://localhost:${port}/callback`;
      const deviceName = getDeviceKeyName();
      const loginUrl = `${AUTH_URL}?redirect=${encodeURIComponent(redirect)}&device_name=${encodeURIComponent(deviceName)}`;

      console.log('');
      console.log(`  If the browser doesn't open, visit this URL:`);
      console.log(`  ${chalk.cyan(loginUrl)}`);
      console.log('');

      open(loginUrl).catch(() => {
        // Browser didn't open — the URL is already printed above
      });
    });

    server.on('error', reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Login timed out. Try again.'));
    }, 5 * 60 * 1000);
  });
}
