export type RuntimeDiagnosticSource = 'config' | 'provider' | 'tools' | 'session' | 'resource' | 'context';
export type RuntimeDiagnosticLevel = 'info' | 'warning' | 'error';

export interface RuntimeDiagnostic {
  source: RuntimeDiagnosticSource;
  level: RuntimeDiagnosticLevel;
  /**
   * Backward-compatible alias used by existing CLI rendering code.
   * Prefer `level` in new code.
   */
  type: RuntimeDiagnosticLevel;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function createDiagnostic({
  source,
  level = 'info',
  code,
  message,
  details,
}: {
  source: RuntimeDiagnosticSource;
  level?: RuntimeDiagnosticLevel;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): RuntimeDiagnostic {
  return {
    source,
    level,
    type: level,
    code,
    message,
    details,
  };
}
