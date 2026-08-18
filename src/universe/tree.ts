import { Lru } from '../core/lru.ts';
import { childAt, makeChild, pathKey, rootNode, type Cell, type ChildRef, type Node } from './node.ts';

const NODE_CACHE_CAPACITY = 4096;

export class Tree {
  readonly root: Node;
  readonly seed: number;
  private readonly cache = new Lru<Node>(NODE_CACHE_CAPACITY);

  constructor(seed: number) {
    this.seed = seed;
    this.root = rootNode(seed);
  }

  beginFrame(): void {
    this.cache.beginFrame();
  }

  /** Walk a path from the root, building and caching each node. Returns null on an empty cell. */
  resolve(path: readonly Cell[]): Node | null {
    let node: Node = this.root;
    for (let i = 0; i < path.length; i++) {
      const key = pathKey(path.slice(0, i + 1));
      const cached = this.cache.get(key);
      if (cached) {
        this.cache.pin(key);
        node = cached;
        continue;
      }
      const ref = childAt(node, path[i]!);
      if (!ref) return null;
      node = makeChild(node, ref);
      this.cache.set(key, node);
      this.cache.pin(key);
    }
    return node;
  }

  parentOf(node: Node): Node | null {
    if (node.path.length === 0) return null;
    return this.resolve(node.path.slice(0, -1));
  }

  /** The ref by which `node` hangs off its parent — needed to convert coordinates when ascending. */
  refOf(node: Node): ChildRef | null {
    const parent = this.parentOf(node);
    if (!parent) return null;
    return childAt(parent, node.path[node.path.length - 1]!);
  }
}
