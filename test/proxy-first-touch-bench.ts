// First-touch cost: walking fresh deep nodes builds a proxy (signal, handler, ancestors) per path segment.
// The other benches reuse a handful of warm nodes, so proxy creation is only measured here.
import { performance } from 'node:perf_hooks';
import { createSolidStore } from '../src';

const FANOUT = [30, 10, 10, 5]; // 30 x 10 x 10 x 5 = 15,000 leaves, ~18,000 proxies per walk
const ROUNDS = 7;

type Tree = { [key: string]: Tree | number };

function build(depth: number): Tree | number {
  if (depth === FANOUT.length) return 1;
  const node: Tree = {};
  for (let i = 0; i < FANOUT[depth]!; i++) node[`n${depth}x${i}`] = build(depth + 1);
  return node;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

function walk(round: number): { ms: number; checksum: number } {
  const api = createSolidStore(build(0) as Record<string, unknown>, `first-touch-${round}`);
  const root = api.store as any;
  let checksum = 0;
  const started = performance.now();
  for (let a = 0; a < FANOUT[0]!; a++) {
    const na = root[`n0x${a}`];
    for (let b = 0; b < FANOUT[1]!; b++) {
      const nb = na[`n1x${b}`];
      for (let c = 0; c < FANOUT[2]!; c++) {
        const nc = nb[`n2x${c}`];
        for (let d = 0; d < FANOUT[3]!; d++) checksum += nc[`n3x${d}`]();
      }
    }
  }
  const ms = performance.now() - started;
  api.destroy();
  return { ms, checksum };
}

walk(-1); // warm the JIT
const samples: number[] = [];
let checksum = 0;
for (let round = 0; round < ROUNDS; round++) {
  const result = walk(round);
  samples.push(result.ms);
  checksum += result.checksum;
}
console.log('case\tmedianMs\tchecksum');
console.log(`first-touch-deep-walk-15k-leaves\t${median(samples).toFixed(3)}\t${checksum}`);
