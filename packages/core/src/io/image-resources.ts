import { collectImageReferences } from '@open-pencil/fig'
import type { SceneGraph } from '@open-pencil/scene-graph'

interface ImageResources {
  hashes: ReadonlySet<string>
  load: (hash: string) => Promise<void>
}

const resources = new WeakMap<SceneGraph, ImageResources>()

/** Runtime resources are independent of graph mutations and undo history. */
export function registerImageResources(graph: SceneGraph, source: ImageResources): () => void {
  resources.set(graph, source)
  return () => {
    if (resources.get(graph) === source) resources.delete(graph)
  }
}

export function hasExternalImageResources(graph: SceneGraph): boolean {
  return resources.has(graph)
}

export function externalImageHashes(graph: SceneGraph): ReadonlySet<string> {
  return resources.get(graph)?.hashes ?? new Set()
}

export function imageResourcesReady(graph: SceneGraph): boolean {
  return [...(resources.get(graph)?.hashes ?? [])].every((hash) => graph.images.has(hash))
}

export function referencedImageResources(
  graph: SceneGraph,
  rootIds: readonly string[]
): Set<string> {
  const available = resources.get(graph)?.hashes ?? new Set<string>()
  if (available.size === 0) return new Set()
  const seen = new Set<string>()
  const hashes = new Set<string>()
  function visit(id: string) {
    if (seen.has(id)) return
    seen.add(id)
    const node = graph.getNode(id)
    if (!node) return
    for (const hash of collectImageReferences(node, available)) hashes.add(hash)
    for (const child of node.childIds) visit(child)
    if (node.componentId) visit(node.componentId)
  }
  for (const id of rootIds) visit(id)
  return hashes
}

export async function ensureImageResources(
  graph: SceneGraph,
  hashes?: Iterable<string>
): Promise<void> {
  const source = resources.get(graph)
  if (!source) return
  await Promise.all([...(hashes ?? source.hashes)].map((hash) => source.load(hash)))
}
