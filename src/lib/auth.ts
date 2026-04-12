import http from 'node:http';
import open from 'open';
import type { CliConfig } from '../types.js';

const AUTH_URL = 'https://somewhere.tech/auth/cli';

interface CallbackResult {
  token: string;
  email: string;
  username: string;
}

/**
 * Browser-based OAuth login flow:
 * 1. Start local HTTP server on a random port
 * 2. Open browser to /auth/cli?redirect=http://localhost:PORT/callback
 * 3. User authenticates via Google OAuth
 * 4. Platform redirects to localhost with ?token=smt_...&email=...&username=...
 * 5. Return the received credentials
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
        res.end(`
          <html>
          <body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d0e14;color:#e5e7eb">
            <div style="text-align:center">
              <div style="font-size:48px;margin-bottom:16px">✓</div>
              <h1 style="font-size:24px;margin:0 0 8px;color:#2dd4bf">Logged in</h1>
              <p style="color:#9ca3af">You can close this tab and return to the terminal.</p>
            </div>
          </body>
          </html>
        `);

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
      const loginUrl = `${AUTH_URL}?redirect=${encodeURIComponent(redirect)}`;
      open(loginUrl);
    });

    server.on('error', reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Login timed out. Try again.'));
    }, 5 * 60 * 1000);
  });
}
