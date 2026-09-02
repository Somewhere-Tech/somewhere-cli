/**
 * `somewhere dev` accepts the entry forms `somewhere deploy` accepts.
 *
 * A project whose index.html points at `/src/main.js` deploys and serves
 * correctly — the platform serves plain JavaScript modules as written rather
 * than compiling them — but the local loop refused to start on it at all
 * (pfb_e32a4e630c45). Both directions are pinned here: the forms that must
 * now resolve, and the project shapes that must still be refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRawServedEntry, resolveDevEntry, detectBundleEntry } from '../dist/local/compiler.js';

const html = (src) =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>` +
  (src ? `<script type="module" src="${src}"></script>` : '') +
  `</body></html>`;

// --- the forms that must resolve ------------------------------------------

test('a .js entry named by index.html resolves, served as written', () => {
  const entry = resolveDevEntry({
    'index.html': html('/src/main.js'),
    'src/main.js': 'document.body.textContent = "hi";',
  });
  assert.deepEqual(entry, { kind: 'raw', entry: 'src/main.js' });
});

test('the reported root-level /app.js layout resolves, served as written', () => {
  const entry = resolveDevEntry({
    'index.html': html('/app.js'),
    'app.js': 'document.body.textContent = "hi";',
  });
  assert.deepEqual(entry, { kind: 'raw', entry: 'app.js' });
});

test('.mjs and .cjs entries resolve the same way', () => {
  for (const ext of ['mjs', 'cjs']) {
    const entry = resolveDevEntry({
      'index.html': html(`/src/main.${ext}`),
      [`src/main.${ext}`]: 'export default 1;',
    });
    assert.deepEqual(entry, { kind: 'raw', entry: `src/main.${ext}` });
  }
});

test('a .tsx entry still resolves as compiled — the compiled path is unchanged', () => {
  const files = {
    'index.html': html('/src/main.tsx'),
    'src/main.tsx': 'export default 1;',
  };
  assert.deepEqual(resolveDevEntry(files), { kind: 'compiled', entry: 'src/main.tsx' });
  assert.equal(detectBundleEntry(files), 'src/main.tsx');
});

test('.ts, .jsx, .mts and .cts entries all resolve as compiled', () => {
  for (const ext of ['ts', 'jsx', 'mts', 'cts']) {
    const entry = resolveDevEntry({
      'index.html': html(`/src/main.${ext}`),
      [`src/main.${ext}`]: 'export default 1;',
    });
    assert.deepEqual(entry, { kind: 'compiled', entry: `src/main.${ext}` });
  }
});

test('a compilable entry wins over a raw one in the same document', () => {
  const entry = resolveDevEntry({
    'index.html':
      `<!doctype html><body>` +
      `<script type="module" src="/src/vendor.js"></script>` +
      `<script type="module" src="/src/main.tsx"></script>` +
      `</body>`,
    'src/vendor.js': 'export const v = 1;',
    'src/main.tsx': 'export default 1;',
  });
  assert.deepEqual(entry, { kind: 'compiled', entry: 'src/main.tsx' });
});

test('a page with no module script at all is served as written, not refused', () => {
  // Browser-Babel projects (`<script type="text/babel">`) and plain static
  // sites deploy and serve; the loop must run them too.
  const entry = resolveDevEntry({
    'index.html': '<!doctype html><body><script type="text/babel" src="/app.jsx"></script></body>',
    'app.jsx': 'const x = <div/>;',
  });
  assert.equal(entry.kind, 'raw');
  assert.equal(entry.entry, '');
});

// --- the shape that must still be refused ---------------------------------

test('index.html naming a file that is not in the directory reports it by name', () => {
  const entry = resolveDevEntry({ 'index.html': html('/src/main.tsx') });
  assert.equal(entry.kind, 'none');
  assert.deepEqual(entry.declared, ['src/main.tsx']);
});

test('a missing root-level entry reports the path index.html actually names', () => {
  const entry = resolveDevEntry({ 'index.html': html('/app.js') });
  assert.deepEqual(entry, { kind: 'none', declared: ['app.js'] });
});

test('a declared entry missing on disk is refused whatever its extension', () => {
  for (const ext of ['tsx', 'ts', 'jsx', 'js', 'mjs']) {
    const entry = resolveDevEntry({ 'index.html': html(`/src/main.${ext}`) });
    assert.equal(entry.kind, 'none', `src/main.${ext}`);
  }
});

// --- the raw/compiled split matches the deploy pipeline's --------------------

test('isRawServedEntry covers exactly the extensions the platform serves as written', () => {
  for (const p of ['src/main.js', 'a.mjs', 'a.cjs', 'A.JS']) {
    assert.equal(isRawServedEntry(p), true, p);
  }
  for (const p of ['src/main.tsx', 'a.ts', 'a.jsx', 'a.mts', 'a.cts']) {
    assert.equal(isRawServedEntry(p), false, p);
  }
});
