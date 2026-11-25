import type { z } from 'zod';
import { validation } from '../errors/app-error.js';

export const UNKNOWN_FIELD_MESSAGE = 'is not a known field';

export function validate<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  root = 'body',
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw validation(fieldErrorsOf(parsed.error, root));
}

function fieldErrorsOf(error: z.ZodError, root: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const add = (key: string, message: string) => {
    fields[key] ??= message;
  };
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        add(fieldName([...issue.path, key], root), UNKNOWN_FIELD_MESSAGE);
      }
    } else {
      add(fieldName(issue.path, root), issue.message);
    }
  }
  return fields;
}

export function fieldName(path: readonly PropertyKey[], root: string): string {
  let name = '';
  for (const segment of path) {
    if (typeof segment === 'number') name += `[${String(segment)}]`;
    else name += name === '' ? String(segment) : `.${String(segment)}`;
  }
  return name === '' ? root : name;
}
