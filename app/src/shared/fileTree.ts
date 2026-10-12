import { rank } from './fuzzy'

/** Details → Files: a session's file list as a tree, and the filter over it (also ⌘P's). */

export interface TreeNode {
  name: string
  path: string
  /** A folder; a file has none. */
  children?: TreeNode[]
}

/** Matches shown for a filter (the tree or ⌘P); more is noise and slow to draw. */
export const TREE_FILTER_MAX = 200

const byName = (a: TreeNode, b: TreeNode) => {
  if (!!a.children !== !!b.children) return a.children ? -1 : 1
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }
  const folders = new Map<string, TreeNode>([['', root]])
  for (const p of paths) {
    const parts = p.split('/')
    let parent = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let f = folders.get(path)
      if (!f) {
        f = { name: parts[i], path, children: [] }
        folders.set(path, f)
        parent.children!.push(f)
      }
      parent = f
    }
    parent.children!.push({ name: parts[parts.length - 1], path: p })
  }
  const sort = (n: TreeNode) => {
    n.children?.sort(byName).forEach(sort)
  }
  sort(root)
  return root.children!
}

/** Paths matching a query, best first (all of them, in order, for an empty one). */
export function filterPaths(paths: string[], query: string): string[] {
  if (!query.trim()) return paths
  return rank(query, paths, (p) => p, TREE_FILTER_MAX)
}
