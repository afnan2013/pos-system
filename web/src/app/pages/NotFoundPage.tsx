import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Link className="text-primary underline underline-offset-4" to="/">
        Go to the start page
      </Link>
    </main>
  );
}
