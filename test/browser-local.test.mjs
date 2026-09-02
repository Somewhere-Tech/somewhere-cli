/**
 * `somewhere browser` can look at the app `somewhere dev` is serving.
 *
 * The hosted browser runs on the platform, so it cannot reach a loopback
 * address — it refused one, and the two halves of this CLI could not talk to
 * each other: the local dev server it had just started was the one address its
 * own browser tool would not visit. Every visual and DOM check waited until
 * after the first production deploy, which is the opposite of the workflow
 * `somewhere dev` sells (tsk_9ec50c8423).
 *
 * It also proves the other half of tsk_bdd72f02c2: a wait that MATCHES and a
 * snapshot that reports "0 interactive elements" were describing the same page
 * and disagreeing about it. Here the two read the same static fixture — three
 * buttons and two inputs, the shape from the original report — and the snapshot
 * must list what the wait found.
 *
 * Skips (loudly) when the machine has no browser installed. That is a real
 * state on a build box, and a skipped check that says so is better than a
 * hundreds-of-megabytes download nobody asked for.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { findBrowser } from '../dist/local/chrome.js';
import { isLoopbackUrl, runLocalBrowser } from '../dist/local/browser-run.js';

/** Three buttons and two inputs — the page shape from the original report. */
const FIXTURE_HTML = `<!doctype html>
<html><head><title>local fixture</title></head><body>
  <form id="signin">
    <input type="email" name="email" placeholder="Email">
    <input type="password" name="password" placeholder="Password">
    <button type="submit">Sign in</button>
    <button type="button" data-testid="signup">Sign up</button>
  </form>
  <button id="third">Third</button>
  <section hidden><button id="hidden-action">Hidden action</button></section>
  <button id="disabled-action" disabled>Disabled action</button>
  <script>
    // Render one button late, so a snapshot taken before the wait resolves
    // would visibly disagree with the wait.
    setTimeout(() => {
      const b = document.createElement('button');
      b.id = 'late';
      b.textContent = 'Late';
      document.body.appendChild(b);
    }, 300);
  </script>
</body></html>`;

/** Serve one static page on loopback, like a dev server would. */
async function serveFixture(html = FIXTURE_HTML) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://localhost:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('loopback addresses are recognised as this machine, and public ones are not', () => {
  for (const url of [
    'http://localhost:8790/',
    'http://localhost:8790/dashboard',
    'http://127.0.0.1:5173/',
    'http://127.1.2.3:3000/',
    'http://app.localhost:5173/',
    'http://[::1]:8080/',
  ]) {
    assert.equal(isLoopbackUrl(url), true, url);
  }
  for (const url of [
    'https://my-app.somewhere.site/',
    'https://example.com/',
    'https://notlocalhost.example.com/',
    'https://localhost.example.com/',
    'not a url',
  ]) {
    assert.equal(isLoopbackUrl(url), false, url);
  }
});

test('the local browser reports the interactive elements its own wait found', async (t) => {
  const browser = findBrowser();
  if (!browser) {
    t.skip(
      'no browser installed on this machine — install Chrome/Chromium/Edge, or set ' +
        'SOMEWHERE_BROWSER_PATH, to run this check',
    );
    return;
  }

  const fixture = await serveFixture();
  try {
    const report = await runLocalBrowser({
      url: fixture.url,
      wait: 'button',
      viewport: { width: 1280, height: 800 },
      timeoutMs: 60_000,
    });

    assert.equal(report.environment, 'local');
    assert.equal(report.passed, true, JSON.stringify(report, null, 2));

    const wait = report.steps.find((s) => s.action === 'wait_for');
    assert.ok(wait, 'the wait ran');
    assert.equal(wait.ok, true, `the wait matched a button: ${wait.error ?? ''}`);

    // The whole point: the map is not empty when the wait matched.
    const tags = report.dom_outline.map((el) => el.tag);
    const buttons = tags.filter((t) => t === 'button');
    const inputs = tags.filter((t) => t === 'input');
    assert.ok(
      buttons.length >= 3,
      `the snapshot must list the buttons the wait found (got ${JSON.stringify(tags)})`,
    );
    assert.equal(inputs.length, 2, JSON.stringify(tags));

    // The map is read AFTER the wait, so it describes the page as it stands —
    // including the element that only exists once the page has settled.
    assert.ok(
      report.dom_outline.some((el) => el.testid === 'signup'),
      'the testid handle map reaches the elements the developer will target',
    );
    assert.equal(report.testid_map.signup, '[data-testid="signup"]');
    assert.equal(report.dom_outline.find((el) => el.id === 'hidden-action')?.visible, false);
    assert.equal(report.dom_outline.find((el) => el.id === 'disabled-action')?.visible, true);
    assert.equal(report.dom_outline.find((el) => el.id === 'disabled-action')?.disabled, true);
  } finally {
    await fixture.close();
  }
});

test('visible-only local outlines omit hidden controls and retain disabled annotations', async (t) => {
  if (!findBrowser()) {
    t.skip('no browser installed on this machine');
    return;
  }
  const fixture = await serveFixture();
  try {
    const report = await runLocalBrowser({
      url: fixture.url,
      visibleOnly: true,
      viewport: { width: 1280, height: 800 },
      timeoutMs: 60_000,
    });
    assert.equal(report.dom_outline.some((el) => el.id === 'hidden-action'), false);
    assert.equal(report.dom_outline.find((el) => el.id === 'disabled-action')?.disabled, true);
  } finally {
    await fixture.close();
  }
});

test('local action sequence drives a form and treats an expected 401 as healthy', async (t) => {
  if (!findBrowser()) {
    t.skip('no browser installed on this machine');
    return;
  }
  const server = createServer((req, res) => {
    if (req.url === '/api/tasks') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"expected refusal"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <input id="title">
      <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
      <button id="save" type="button">Save</button>
      <p id="status"></p>
      <script>
        document.getElementById('save').addEventListener('click', async () => {
          await fetch('/api/tasks');
          const statusNode = document.getElementById('status');
          statusNode.textContent = document.getElementById('title').value + ':' +
            document.getElementById('plan').value;
          statusNode.className = 'ready';
        });
      </script>
    </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const report = await runLocalBrowser({
      url: `http://localhost:${port}/`,
      actions: [
        { fill: '#title', value: 'Launch' },
        { select: '#plan', value: 'pro' },
        { click: '#save' },
        { wait: '.ready' },
        { expect: { selector: '#status', text: 'Launch:pro', visible: true, count: 1 } },
        { eval: 'document.querySelector("#status").textContent' },
      ],
      expectedRequests: [{ path: '/api/tasks', status: 401 }],
      viewport: { width: 1280, height: 800 },
      timeoutMs: 60_000,
    });
    assert.equal(report.passed, true, JSON.stringify(report, null, 2));
    assert.equal(report.failed_requests.length, 0);
    assert.equal(report.request_expectations?.[0]?.ok, true);
    assert.equal(report.steps.length, 6);
    assert.ok(report.steps.every((step) => step.ok));
    assert.equal(report.steps.at(-1).result, 'Launch:pro');
    assert.equal(
      report.console_errors.some((entry) => /Failed to load resource/.test(entry) && /401/.test(entry)),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the local browser surfaces a failed request from the page', async (t) => {
  const browser = findBrowser();
  if (!browser) {
    t.skip('no browser installed on this machine');
    return;
  }

  const server = createServer((req, res) => {
    if (req.url === '/api/missing') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><body><button>Go</button>' +
        "<script>fetch('/api/missing');</script></body></html>",
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const report = await runLocalBrowser({
      url: `http://localhost:${port}/`,
      wait: 'button',
      viewport: { width: 1280, height: 800 },
      timeoutMs: 60_000,
    });
    assert.ok(
      report.failed_requests.some((r) => r.status === 500 && String(r.url).includes('/api/missing')),
      `the failing request is in the report: ${JSON.stringify(report.failed_requests)}`,
    );
    assert.equal(report.passed, false, 'a page with a failing request is not healthy');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a wait that never matches is a failed step, not a silent pass', async (t) => {
  const browser = findBrowser();
  if (!browser) {
    t.skip('no browser installed on this machine');
    return;
  }
  const fixture = await serveFixture('<!doctype html><html><body><p>nothing here</p></body></html>');
  try {
    const report = await runLocalBrowser({
      url: fixture.url,
      wait: '#never-appears',
      viewport: { width: 1280, height: 800 },
      timeoutMs: 3_000,
    });
    const wait = report.steps.find((s) => s.action === 'wait_for');
    assert.equal(wait.ok, false);
    assert.match(wait.error, /#never-appears/);
    assert.equal(report.passed, false);
  } finally {
    await fixture.close();
  }
});
