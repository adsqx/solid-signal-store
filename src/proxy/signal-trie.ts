/**
 * Path trie of the observed signals: branch wake costs O(observed descendants of the branch)
 * instead of an O(all signals) scan. Paths are split on '.', the dot-joined form the proxy
 * builds; a prefix never matches itself, only its present descendants.
 */

interface TrieNode {
  children: Map<string, TrieNode> | null;
  present: boolean;
}

const DOT = 46;
const newNode = (): TrieNode => ({ children: null, present: false });

export class SignalTrie {
  private readonly root = newNode();

  add(path: string): void {
    if (path) this.walk(path, true)!.present = true;
  }

  descendantsOf(prefix: string): string[] {
    return this.collectFrom(prefix, []);
  }

  /** Descendants of any of the prefixes, each path once even when the prefixes overlap. */
  descendantsOfAny(prefixes: readonly string[]): string[] {
    const valid = prefixes.filter(Boolean);
    if (valid.length < 2) return valid.length ? this.descendantsOf(valid[0]!) : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const prefix of valid) this.collectFrom(prefix, out, seen);
    return out;
  }

  /**
   * Splice-precise descendants: only the subtrees of array indices >= startIndex. After
   * splice(startIndex, ...) the prefix [0, startIndex) keeps both value AND index, so its signals
   * must not be woken. Non-numeric children (should not occur on arrays) are always included.
   */
  descendantsFromArrayIndex(arrayPath: string, startIndex: number): string[] {
    return this.collectFrom(arrayPath, [], undefined, startIndex);
  }

  private collectFrom(prefix: string, out: string[], seen?: Set<string>, minIndex?: number): string[] {
    const node = prefix ? this.walk(prefix, false) : undefined;
    if (node?.children) this.collect(node, prefix, out, seen, minIndex);
    return out;
  }

  /** Follows the '.'-separated segments of `path`; `create` builds missing nodes, else stops at the first gap. */
  private walk(path: string, create: boolean): TrieNode | undefined {
    let node: TrieNode = this.root;
    let start = 0;
    const len = path.length;
    for (let i = 0; i <= len; i++) {
      if (i !== len && path.charCodeAt(i) !== DOT) continue;
      const seg = path.slice(start, i);
      start = i + 1;
      let children = node.children;
      if (!children) {
        if (!create) return undefined;
        children = node.children = new Map();
      }
      let child = children.get(seg);
      if (!child) {
        if (!create) return undefined;
        child = newNode();
        children.set(seg, child);
      }
      node = child;
    }
    return node;
  }

  /** Appends the present descendants of `node`; `minIndex` filters integer children of `node` itself only. */
  private collect(node: TrieNode, prefix: string, out: string[], seen?: Set<string>, minIndex?: number): void {
    for (const [seg, child] of node.children!) {
      if (minIndex !== undefined) {
        const idx = Number(seg);
        if (Number.isInteger(idx) && idx < minIndex) continue;
      }
      const childPath = `${prefix}.${seg}`;
      if (child.present && !seen?.has(childPath)) {
        seen?.add(childPath);
        out.push(childPath);
      }
      if (child.children) this.collect(child, childPath, out, seen);
    }
  }
}
