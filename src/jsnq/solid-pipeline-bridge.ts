/**
 * Thin Solid integration layer over @adsq/jsnq. Every reusable fast path (flat-array where+actions COW
 * engine, single-action structural shortcuts, sugar deep patch) lives in the shared library; the bridge
 * keeps only what is Solid-specific: the root-replace shortcut (Solid reactivity wants a fresh deep
 * reference) and the defensive full-pipeline fallback that never throws into the reactive graph.
 */

import { PipelineWrapper } from '@adsq/jsnq/core/pipeline-wrapper';
import { cloneJsonData as cloneJson } from '@adsq/jsnq/data-engine';
import { collectPipelineIntent, tryFastMutation, tryFastPipelineMutation } from '@adsq/jsnq/core/pipeline-fastpath';

export interface SolidPipelineOptions {
  isRoot?: boolean;
  path?: string;
  /**
   * How the bridge reacts to an execution error.
   *  - 'warn' (default): log a warning and return a safe clone — never throws into
   *    the reactive graph. This is the historical behaviour (unchanged default).
   *  - 'silent': return a safe clone without logging.
   *  - 'throw': rethrow so callers (typically dev) see the real error instead of a
   *    silent no-op (e.g. moveTo('bad.target') becoming a swallowed warning).
   */
  bridgeErrorMode?: 'throw' | 'warn' | 'silent';
  /** Collect per-match operation strings only while development diagnostics are active. */
  trackOperations?: boolean;
}

export interface SolidJsnqBridge {
  applyPipelineMutation: typeof applyPipelineMutation;
  applyPipelineMutationDetailed: typeof applyPipelineMutationDetailed;
  createPipeline: typeof createPipeline;
}

export interface DetailedMutationResult {
  /** New branch value (identical to applyPipelineMutation's return). */
  value: unknown;
  /**
   * Affected paths RELATIVE to the mutated branch (e.g. "0.profile.name"), enabling
   * the host to wake exactly those leaves instead of the whole branch. `null` when
   * precise wake is not applicable (structural ops, deep `@`, sugar patches, root,
   * nested-candidate criteria) — the caller MUST fall back to a normal commit.
   */
  mutations: string[] | null;
}

type BridgeErrorMode = NonNullable<SolidPipelineOptions['bridgeErrorMode']>;

/** Loosely-typed view of a jsnq operator, for the root-replace shortcut only. */
interface RootOpLike {
  __isMutation?: boolean;
  type?: string;
  key?: unknown;
  value?: unknown;
}

/** Rethrows in 'throw' mode; otherwise logs (unless 'silent') and hands back a safe clone. */
function recoverFromError(
  mode: BridgeErrorMode,
  log: (...args: unknown[]) => void,
  message: string,
  error: unknown,
  value: unknown
): unknown {
  if (mode === 'throw') throw error;
  if (mode !== 'silent') log(`[solid-pipeline-bridge] ${message}`, error);
  return cloneJson(value);
}

type PipelineData = ConstructorParameters<typeof PipelineWrapper>[0];
type PipelineArgs = Parameters<PipelineWrapper['pipeline']>;

function buildWrapper(
  currentValue: unknown,
  ops: readonly unknown[],
  autoClone: boolean,
  options: SolidPipelineOptions
): PipelineWrapper {
  const wrapper = new PipelineWrapper(currentValue as PipelineData, {
    autoClone,
    trackOperations: options.trackOperations ?? false,
  });
  if (ops && ops.length > 0) wrapper.pipeline(...(ops as PipelineArgs));
  return wrapper;
}

export function applyPipelineMutation(
  ops: readonly unknown[],
  currentValue: unknown,
  options: SolidPipelineOptions = {}
): unknown {
  if (!ops || ops.length === 0) return currentValue;

  const errorMode = options.bridgeErrorMode ?? 'warn';

  try {
    // Root-level replace (very common): no pipeline needed.
    if ((options.isRoot ?? !options.path) && ops.length === 1) {
      const op = ops[0] as RootOpLike | null | undefined;
      if (op && typeof op === 'object' && !op.__isMutation) return cloneJson(op);
      if (op?.__isMutation && op.type === 'replace') {
        if (op.key == null || op.key === '') return cloneJson(typeof op.value === 'function' ? op.value(currentValue) : op.value);
        if (typeof op.key === 'object') return cloneJson(op.key);
      }
    }

    // jsnq's fast cascade, shared with the Angular store: flat copy-on-write, structural shortcut, deep sugar patch.
    const fast = tryFastMutation(currentValue, ops, { collectAffectedPaths: false });
    if (fast) return fast.value;

    // Standard ops (update('key', valOrFn), replace, deletes, moves, multi-op). Guarded so unexpected
    // null/undefined edge cases degrade to a structural clone (undefined props may drop) instead of throwing.
    try {
      const wrapper = buildWrapper(currentValue, ops, true, options);
      wrapper.execute('all');
      return wrapper.data;
    } catch (execErr) {
      return recoverFromError(errorMode, console.warn, 'Execution warning (standard path):', execErr, currentValue);
    }
  } catch (e) {
    return recoverFromError(errorMode, console.error, 'Pipeline execution failed:', e, currentValue);
  }
}

/**
 * Like applyPipelineMutation, but also reports which leaf paths (relative to the branch) changed, for the
 * host's fine-grained wake. Only the flat array + non-deep criteria + string-key value-action shape is
 * precise; everything else returns mutations:null so the caller keeps the normal commit.
 */
export function applyPipelineMutationDetailed(
  ops: readonly unknown[],
  currentValue: unknown,
  options: SolidPipelineOptions = {}
): DetailedMutationResult {
  if (ops && ops.length > 0) {
    const fast = tryFastPipelineMutation(currentValue, ops);
    if (fast) return { value: fast.value, mutations: fast.affectedPaths };
  }
  return { value: applyPipelineMutation(ops, currentValue, options), mutations: null };
}

// `any` is the published return type; narrowing it would break consumers that read results as their own types.
export function createPipeline(currentValue: unknown, ops: readonly unknown[], options: SolidPipelineOptions = {}): PipelineWrapper<any> {
  return buildWrapper(currentValue, ops, collectPipelineIntent(ops).actions.length > 0, options);
}

export const solidJsnqBridge: SolidJsnqBridge = {
  applyPipelineMutation,
  applyPipelineMutationDetailed,
  createPipeline,
};

/** The globals the bridge publishes itself on (read back by the store's auto-discovery). */
export interface SolidBridgeHost {
  __SOLID_PIPELINE_BRIDGE?: SolidJsnqBridge;
  solidJsnqBridge?: SolidJsnqBridge;
}

export function registerSolidJsnqBridge(target: unknown = globalThis): SolidJsnqBridge {
  const host = target as SolidBridgeHost;
  host.__SOLID_PIPELINE_BRIDGE = solidJsnqBridge;
  host.solidJsnqBridge = solidJsnqBridge;
  return solidJsnqBridge;
}

// Side effect of importing the `/jsnq` entry.
registerSolidJsnqBridge();
