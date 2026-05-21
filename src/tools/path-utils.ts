import * as path from 'node:path';

export function resolveWorkspacePath(workspaceDir: string, targetPath: string): string {
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw new Error(`Path escapes workspace: ${targetPath}`);
}
