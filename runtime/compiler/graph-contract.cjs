'use strict';

// Side-effect-free compiler graph contract. The compiler server and every
// checker import this exact module; there is no copied graph implementation.
const path = require('path');

const GRAPH_MAX_EDGES = 25_000;
const GRAPH_MAX_BYTES = 2 * 1024 * 1024;

function importGraphFromMetafile(metafile, root) {
  const graph = {};
  if (!metafile) return graph;
  for (const [inputPath, info] of Object.entries(metafile.inputs || {})) {
    const rel = path.relative(root, path.resolve(root, inputPath));
    if (rel.startsWith('..') || rel.includes('node_modules')) continue;
    graph[rel] = (info.imports || [])
      .map((item) => path.relative(root, path.resolve(root, item.path)))
      .filter((item) => !item.startsWith('..') && !item.includes('node_modules'));
  }
  return graph;
}

function stripMetafilePath(inputPath, root) {
  let value = String(inputPath || '').replace(/\\/g, '/');
  if (/^(?:https?:|node:|cloudflare:|workerd:)/.test(value)) return null;
  const namespaced = /^([A-Za-z0-9_-]+):(.*)$/.exec(value);
  if (namespaced) value = namespaced[2];
  if (!value || /^(?:https?:|node:|cloudflare:|workerd:)/.test(value)) return null;
  if (root) {
    const absolute = path.isAbsolute(value) ? value : path.resolve(root, value);
    value = path.relative(root, absolute).replace(/\\/g, '/');
  } else if (path.isAbsolute(value)) {
    return null;
  }
  value = value.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!value || value === '..' || value.startsWith('../') || value.startsWith('<') || value.includes('node_modules/')) return null;
  return value;
}

function graphWithCounts(edges, originalEdges, originalBytes) {
  const graph = {
    edges,
    truncated: true,
    original_edges: originalEdges,
    retained_edges: edges.length,
    dropped_edges: Math.max(0, originalEdges - edges.length),
    max_bytes: GRAPH_MAX_BYTES,
  };
  if (typeof originalBytes === 'number') graph.original_bytes = originalBytes;
  return graph;
}

function graphJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateGraphEdgesForBytes(edges, entryFiles, originalEdges, originalBytes) {
  const candidates = [];
  const candidateKeys = new Set();
  const degree = new Map();
  const byNode = new Map();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
    byNode.set(edge.from, [...(byNode.get(edge.from) || []), edge]);
    byNode.set(edge.to, [...(byNode.get(edge.to) || []), edge]);
  }
  const add = (edge) => {
    const key = `${edge.from}\0${edge.to}`;
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push(edge);
  };
  for (const edge of edges) if (entryFiles.has(edge.from) || entryFiles.has(edge.to)) add(edge);
  for (const [node] of [...degree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    for (const edge of byNode.get(node) || []) add(edge);
  }
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (graphJsonBytes(graphWithCounts(candidates.slice(0, mid), originalEdges, originalBytes)) <= GRAPH_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  return graphWithCounts(candidates.slice(0, low), originalEdges, originalBytes);
}

function graphFromMetafile(metafile, root) {
  if (!metafile) return { edges: [] };
  const edges = [];
  const seen = new Set();
  let originalEdges = 0;
  for (const [inputPath, input] of Object.entries(metafile.inputs || {})) {
    const from = stripMetafilePath(inputPath, root);
    if (!from) continue;
    for (const item of input.imports || []) {
      const to = stripMetafilePath(item.path, root);
      if (!to || to === from) continue;
      const key = `${from}\0${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      originalEdges++;
      if (edges.length < GRAPH_MAX_EDGES) edges.push({ from, to });
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const entryFiles = new Set();
  for (const output of Object.values(metafile.outputs || {})) {
    const entry = output && output.entryPoint ? stripMetafilePath(output.entryPoint, root) : null;
    if (entry) entryFiles.add(entry);
  }
  const stored = { edges };
  const bytes = graphJsonBytes(stored);
  if (bytes > GRAPH_MAX_BYTES) return truncateGraphEdgesForBytes(edges, entryFiles, originalEdges, bytes);
  if (originalEdges > edges.length) return graphWithCounts(edges, originalEdges);
  return stored;
}

module.exports = {
  GRAPH_MAX_EDGES,
  GRAPH_MAX_BYTES,
  importGraphFromMetafile,
  graphFromMetafile,
};
