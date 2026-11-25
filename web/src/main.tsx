import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { Toaster } from 'sonner';
import { queryClient } from '@/app/queryClient';
import { createRouter } from '@/router';
import '@/index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('The #root element is missing from index.html');

const router = createRouter();

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  </StrictMode>,
);
