import { Link } from '@tanstack/react-router';
import { Button } from '~/components/ui/button';

export function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="space-y-3 text-center">
        <p className="font-mono text-sm text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">Nothing here</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          That page does not exist. If you followed a room link, the room may have closed — rooms
          are removed shortly after the last person leaves.
        </p>
        <div className="flex justify-center gap-2 pt-2">
          <Button render={<Link to="/rooms" />} variant="outline">
            Browse rooms
          </Button>
          <Button render={<Link to="/rooms/new" />}>Create a room</Button>
        </div>
      </div>
    </main>
  );
}
