import type { Metadata } from 'next';
import { RoomShell } from '~/components/room/room-shell';

export const metadata: Metadata = { title: 'Room' };

export default async function RoomPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <RoomShell slug={slug} />;
}
