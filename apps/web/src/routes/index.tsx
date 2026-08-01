import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight, Compass, ListMusic, Play, Radio, Shield, Users, Zap } from 'lucide-react';
import { SiteHeader } from '~/components/site-header';
import { Button } from '~/components/ui/button';

export const Route = createFileRoute('/')({
  component: LandingPage,
});

/**
 * The landing page.
 *
 * Nothing here is interactive beyond the header, and it is the one surface
 * where time-to-first-byte is the whole point.
 */
function LandingPage() {
  return (
    <div className="min-h-dvh">
      <SiteHeader />

      <main>
        <section className="mx-auto w-full max-w-5xl px-6 pt-16 pb-20 sm:pt-24">
          <div className="max-w-2xl">
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              Rooms are live now
            </p>

            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
              Watch anything together, <span className="text-muted-foreground">in sync</span>
            </h1>

            <p className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
              Create a room, share one link, and everyone lands on the same frame. YouTube, video
              files, live streams, and whole playlists — the way a real media player handles them.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Button render={<Link to="/rooms/new" />} size="lg">
                <Play className="size-4" />
                Start a room
              </Button>
              <Button render={<Link to="/rooms" />} size="lg" variant="outline">
                <Compass className="size-4" />
                Browse rooms
              </Button>
            </div>
          </div>
        </section>

        <section className="border-t bg-muted/30">
          <div className="mx-auto grid w-full max-w-5xl gap-8 px-6 py-16 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title}>
                <Icon className="mb-3 size-5 text-muted-foreground" />
                <h2 className="mb-1.5 font-medium">{title}</h2>
                <p className="text-sm text-pretty text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-3xl px-6 py-24 text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">
            Your next watch party is one link away
          </h2>
          <p className="mx-auto mt-3 max-w-md text-pretty text-muted-foreground">
            Create a room in about five seconds. Share it. That is the whole setup.
          </p>
          <Button render={<Link to="/rooms/new" />} size="lg" className="mt-8">
            Create a room
            <ArrowRight className="size-4" />
          </Button>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-8 text-xs text-muted-foreground">
          <span>playercn</span>
          <span>Watch together, perfectly in sync.</span>
        </div>
      </footer>
    </div>
  );
}

const FEATURES = [
  {
    icon: Zap,
    title: 'Actually in sync',
    body: 'The server owns the timeline and every player derives its position from it, so a late joiner lands exactly where everyone else is.',
  },
  {
    icon: Radio,
    title: 'Plays what a player plays',
    body: 'YouTube, MP4, WebM, MP3, HLS and DASH. Paste a link and the room works out how to play it.',
  },
  {
    icon: ListMusic,
    title: 'Import whole playlists',
    body: 'Point the room at an M3U, PLS, XSPF or ASX list and every entry lands in the queue at once.',
  },
  {
    icon: Users,
    title: 'Hosts and co-hosts',
    body: 'Promote people you trust, nominate who inherits the room, and get it back automatically when you return.',
  },
  {
    icon: Shield,
    title: 'Rooms that clean up',
    body: 'A room closes shortly after the last person leaves — with enough grace that a refresh never destroys it.',
  },
  {
    icon: Compass,
    title: 'Themes per room',
    body: 'Twelve palettes, light or dark. Pick your own, or let the host set one for everybody in the room.',
  },
] as const;
