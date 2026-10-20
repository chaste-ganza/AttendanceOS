import { Link } from "react-router-dom";

export default function PageNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">404</p>
      <h1 className="font-heading text-3xl font-extrabold">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you requested does not exist.</p>
      <Link className="font-semibold text-primary hover:underline" to="/">Return to dashboard</Link>
    </main>
  );
}
