import type { Tool } from './base.js';

type JsonSchemaObject = Record<string, unknown>;

export class ToolArgumentValidationError extends Error {
  constructor(
    readonly toolName: string,
    readonly errors: string[],
    readonly receivedArgs: unknown,
  ) {
    super(formatToolArgumentValidationError(toolName, errors, receivedArgs));
    this.name = 'ToolArgumentValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaType(schema: JsonSchemaObject): string | undefined {
  const type = schema['type'];
  return typeof type === 'string' ? type : undefined;
}

function schemaProperties(schema: JsonSchemaObject): Record<string, JsonSchemaObject> {
  const properties = schema['properties'];
  if (!isRecord(properties)) return {};
  const result: Record<string, JsonSchemaObject> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (isRecord(value)) result[key] = value;
  }
  return result;
}

function schemaRequired(schema: JsonSchemaObject): string[] {
  const required = schema['required'];
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === 'string') : [];
}

function validatePrimitive(
  schema: JsonSchemaObject,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (schemaType(schema)) {
    case 'string':
      return typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, message: 'expected string' };
    case 'integer': {
      if (typeof value === 'number' && Number.isInteger(value)) return { ok: true, value };
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
        return { ok: true, value: Number(value) };
      }
      return { ok: false, message: 'expected integer' };
    }
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return { ok: true, value: Number(value) };
      }
      return { ok: false, message: 'expected number' };
    }
    case 'boolean':
      if (typeof value === 'boolean') return { ok: true, value };
      if (value === 'true') return { ok: true, value: true };
      if (value === 'false') return { ok: true, value: false };
      return { ok: false, message: 'expected boolean' };
    default:
      return { ok: true, value };
  }
}

function validateObject(schema: JsonSchemaObject, value: unknown, path: string): {
  value: Record<string, unknown>;
  errors: string[];
} {
  if (!isRecord(value)) {
    return { value: {}, errors: [`${path || 'root'}: expected object`] };
  }

  const next = { ...value };
  const errors: string[] = [];
  const properties = schemaProperties(schema);
  for (const key of schemaRequired(schema)) {
    if (next[key] === undefined) errors.push(`${path ? `${path}.` : ''}${key}: required property is missing`);
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (next[key] === undefined) continue;
    const primitive = validatePrimitive(propertySchema, next[key]);
    if (primitive.ok) {
      next[key] = primitive.value;
    } else {
      errors.push(`${path ? `${path}.` : ''}${key}: ${primitive.message}`);
    }
  }

  return { value: next, errors };
}

function formatToolArgumentValidationError(
  toolName: string,
  errors: string[],
  receivedArgs: unknown,
): string {
  const formattedErrors = errors.map((error) => `  - ${error}`).join('\n') || '  - root: invalid arguments';
  return `Validation failed for tool "${toolName}":\n${formattedErrors}\n\nReceived arguments:\n${JSON.stringify(receivedArgs, null, 2)}`;
}

export function validateToolArguments(tool: Tool, args: unknown): Record<string, unknown> {
  const parameters = tool.parameters;
  const rootSchema = isRecord(parameters) ? parameters : {};
  const rootType = schemaType(rootSchema);
  const shouldValidateObject = rootType === 'object' || rootSchema['properties'] !== undefined || rootSchema['required'] !== undefined;
  if (!shouldValidateObject) return isRecord(args) ? { ...args } : {};

  const validated = validateObject(rootSchema, args, '');
  if (validated.errors.length > 0) {
    throw new ToolArgumentValidationError(tool.name, validated.errors, args);
  }
  return validated.value;
}
