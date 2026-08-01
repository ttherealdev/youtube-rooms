import { createFileRoute } from '@tanstack/react-router';
import { RoomShell } from '~/components/room/room-shell';

export const Route = createFileRoute('/rooms/$slug')({
  component: RoomRoute,
  head: () => ({ meta: [{ title: 'Room · playercn' }] }),
});

function RoomRoute() {
  const { slug } = Route.useParams();
  return <RoomShell slug={slug} />;
}
