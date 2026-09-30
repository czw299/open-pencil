# Todo embedding

Build the web application and open `/?embed=todo` from the Flutter-owned loopback origin.
The host supplies an ephemeral bearer token through `op-bridge/init` and serves
`GET /todo/document` and `PUT /todo/snapshot?requestId=...`. Binary .fig payloads
never pass through JavaScript evaluation. Requests require `Authorization: Bearer <token>`.

The bridge speaks protocol version 1 using JSON-string window messages, checks the
same window and origin, and confirms saves only after `op-bridge/save-committed`
matches the exported generation and content revision. Editing during upload remains dirty.
Failed uploads remain the host's responsibility; no browser download marks the document saved.
Menus/tabs for switching documents, browser recovery, autosave, storage synchronization,
PWA registration and automation startup are disabled in this mode. Ctrl+S requests a host save.

Build: `bun install --frozen-lockfile`, `bun run build:packages`, `bun run build`,
then `bun scripts/build-todo-empty.ts`. Ship the whole dist directory, including empty.fig,
CanvasKit WASM, workers, fonts and assets. The Flutter application handles cloud locks,
upload retries, window close prompts and release of each loopback server.

Before sending a snapshot, the bridge prunes image entries absent from the final
serialized canvas payload. It scans all serialized pages and nested fields and
leaves canvas bytes untouched, including exports reusing an original archive.
The live image map, external resource mappings and undo history are retained for
a later save. The Flutter host reports obsolete cloud image paths through deletes;
the backend owns soft deletion and historical resource retention.


### Asynchronous cloud images

Cloud sessions open the existing `todo-fig/1` structure and manifest without downloading
images. The authenticated `/todo/images/<sha256>` endpoint serves only digests owned
by this session, using the host's verified disk cache. Vue loads active-page resources
with four concurrent requests, deduplicates requests, retries failures, and invalidates
retained rendering pictures when bytes arrive. Resource arrival does not edit the graph.

Todo snapshots retain referenced external manifest entries even when their bytes have
never loaded; new images remain embedded until the host splits and uploads them. This
also keeps failed-save recovery self-contained for new resources. Loaded old images
are omitted from snapshots. The host compares structure plus canonical resource
manifests for conflicts, pins deleted resources in its cache before reporting `deletes`,
and re-registers cached images when undo restores a deleted reference. The in-session
manifest retains old mappings for undo; cache eviction is not implemented.

Standalone FIG exports hydrate resources and bypass the structure-only original-archive
shortcut. Selection exports, clipboard copy and vectorization await required images.
While resources are incomplete, cloud snapshots retain the original thumbnail.
Strict viewport loading and resource-memory eviction remain future work. Local standalone
files continue to use complete `.fig` bytes. Hosts without this protocol reject cloud
envelopes instead of silently treating unavailable images as deleted.
