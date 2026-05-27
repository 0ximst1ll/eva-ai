import * as path from 'node:path';

export interface ResolveWorkspacePathOptions {
  allowOutsideWorkspace?: boolean;
}

export function resolveWorkspacePath(
  workspaceDir: string,
  targetPath: string,
  options: ResolveWorkspacePathOptions = {},
): string {
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);

  if (options.allowOutsideWorkspace || relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw new Error(`Path escapes workspace: ${targetPath}`);
}

export function isWorkspacePath(workspaceDir: string, targetPath: string): boolean {
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
