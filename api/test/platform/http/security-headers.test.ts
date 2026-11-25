import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../../../src/platform/http/security-headers.js';
import { platformApp } from '../../support/http.js';

const app = platformApp((app) => {
  app.get('/ok', (_req, res) => {
    res.json({ ok: true });
  });
});

describe('securityHeaders', () => {
  it.each([
    ['a success', '/ok', 200],
    ['a problem', '/missing', 404],
  ])('sets every header on %s', async (_label, path, status) => {
    const response = await request(app).get(path);
    expect(response.status).toBe(status);
    expect(response.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
      'content-security-policy': CONTENT_SECURITY_POLICY,
    });
  });

  it('allows no inline script and no outside origin', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self';");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*/);
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });
});
