import axios from 'axios';
import { toApiError } from './ApiError';

export const apiClient = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.response.use(undefined, (error: unknown) =>
  Promise.reject(toApiError(error)),
);
