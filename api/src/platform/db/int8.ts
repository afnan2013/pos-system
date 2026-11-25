import pg, { type CustomTypesConfig } from 'pg';

export function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError('int8 value is outside the safe integer range of a JavaScript number');
  }
  return parsed;
}

export const int8AsNumber: CustomTypesConfig = {
  getTypeParser: (id, format) =>
    id === pg.types.builtins.INT8 && format !== 'binary'
      ? parseInt8
      : (pg.types.getTypeParser(id, format) as unknown),
};
