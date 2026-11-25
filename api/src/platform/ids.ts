import { v7 } from 'uuid';

export interface IdGenerator {
  next(): string;
}

export const uuidV7Ids: IdGenerator = {
  next: () => v7(),
};
