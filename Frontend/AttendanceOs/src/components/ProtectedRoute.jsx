import { Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';

export default function ProtectedRoute({ unauthenticatedElement }) {
  const { isAuthenticated, loading, error, refresh } = useAuth();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground" role="status">Checking your account…</div>;
  }

  if (error) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="font-semibold">Could not reach the account service.</p>
        <p className="max-w-md text-sm text-muted-foreground">{error.message}</p>
        <Button onClick={refresh}>Retry</Button>
      </main>
    );
  }

  if (!isAuthenticated) {
    return unauthenticatedElement;
  }

  return <Outlet />;
}
