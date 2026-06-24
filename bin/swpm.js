#!/usr/bin/env node
import { main } from '../dist/swpm-bin.js';

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
