import express, { type Router } from 'express';

export function mountRoutes(): Router {
  return express.Router();
}
