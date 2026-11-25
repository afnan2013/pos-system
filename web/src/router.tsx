import { createBrowserRouter, type RouteObject } from 'react-router';
import { NotFoundPage } from '@/app/pages/NotFoundPage';
import { StartPage } from '@/app/pages/StartPage';

export const routes: RouteObject[] = [
  { path: '/', element: <StartPage /> },
  { path: '*', element: <NotFoundPage /> },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
