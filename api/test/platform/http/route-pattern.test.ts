import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  allowedMethods,
  markStaticRoute,
  recordRoutePrefix,
  routeOf,
  STATIC_ROUTE,
} from '../../../src/platform/http/route-pattern.js';
import { platformApp } from '../../support/http.js';

const app = platformApp((app) => {
  const router = express.Router();
  router.get('/things/:thingId', (req, res) => {
    res.json({ route: routeOf(req) });
  });
  app.use('/v1', recordRoutePrefix, router);
  app.get('/items/:itemId', (req, res) => {
    res.json({ route: routeOf(req) });
  });
  app.get('/assets/logo.svg', (req, res) => {
    markStaticRoute();
    res.json({ route: routeOf(req) });
  });
  app.use('/loose', (req, res) => {
    res.json({ route: routeOf(req) ?? null, allowed: allowedMethods(req) });
  });
  app
    .route('/read-write')
    .get((req, res) => {
      res.json({ allowed: allowedMethods(req) });
    })
    .post((req, res) => {
      res.json({ allowed: allowedMethods(req) });
    });
  app
    .route('/with-head')
    .head((_req, res) => {
      res.end();
    })
    .get((req, res) => {
      res.json({ allowed: allowedMethods(req) });
    });
  app.post('/write-only', (req, res) => {
    res.json({ allowed: allowedMethods(req) });
  });
});

describe('routeOf', () => {
  it('gives the matched pattern, never the raw path', async () => {
    const response = await request(app).get('/items/abc-123');
    expect(response.body).toEqual({ route: '/items/:itemId' });
  });

  it('keeps the mount path recorded before a router', async () => {
    const response = await request(app).get('/v1/things/42');
    expect(response.body).toEqual({ route: '/v1/things/:thingId' });
  });

  it('reports a file served as static', async () => {
    const response = await request(app).get('/assets/logo.svg');
    expect(response.body).toEqual({ route: STATIC_ROUTE });
  });

  it('is undefined in middleware that matched no route', async () => {
    const response = await request(app).get('/loose/anything');
    expect(response.body).toEqual({ route: null, allowed: [] });
  });
});

describe('allowedMethods', () => {
  it('lists the route methods and adds HEAD for GET', async () => {
    const response = await request(app).post('/read-write');
    expect(response.body).toEqual({ allowed: ['GET', 'POST', 'HEAD'] });
  });

  it('does not list HEAD twice when the route declares it', async () => {
    const response = await request(app).get('/with-head');
    expect(response.body).toEqual({ allowed: ['HEAD', 'GET'] });
  });

  it('does not add HEAD without GET', async () => {
    const response = await request(app).post('/write-only');
    expect(response.body).toEqual({ allowed: ['POST'] });
  });
});
