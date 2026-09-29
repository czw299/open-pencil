import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { exportFigFile } from '@open-pencil/core/io/formats/fig'
import { resolveWorkspaceRoot } from '@open-pencil/package-artifacts'
import { SceneGraph } from '@open-pencil/scene-graph'

const root = await resolveWorkspaceRoot(process.cwd())
await writeFile(join(root, 'dist/empty.fig'), await exportFigFile(new SceneGraph()))
