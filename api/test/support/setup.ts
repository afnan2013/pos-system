import { afterEach } from 'vitest';
import { silenceLogs } from './logs.js';

silenceLogs();

afterEach(() => {
  silenceLogs();
});
