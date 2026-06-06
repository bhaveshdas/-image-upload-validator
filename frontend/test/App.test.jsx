import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, vi } from 'vitest';
import App from '../src/App.jsx';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ images: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('renders the upload dashboard shell', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
  expect(screen.getByText('Upload queue')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Accepted' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Rejected' })).toBeTruthy();
});
