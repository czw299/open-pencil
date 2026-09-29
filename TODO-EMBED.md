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
