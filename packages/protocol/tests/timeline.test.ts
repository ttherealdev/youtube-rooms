import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Timeline } from '../src/timeline.ts';
import { decideCorrection, positionAt, SYNC } from '../src/timeline.ts';

const T0 = 1_700_000_000_000;

const YOUTUBE_SOURCE = {
  kind: 'youtube',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  videoId: 'dQw4w9WgXcQ',
} as const;

function playing(overrides: Partial<Timeline> = {}): Timeline {
  return {
    source: YOUTUBE_SOURCE,
    anchorPos: 0,
    anchorAt: T0,
    rate: 1,
    paused: false,
    version: 1,
    queueItemId: null,
    loop: false,
    duration: null,
    ...overrides,
  };
}

describe('positionAt', () => {
  it('advances with the server clock', () => {
    assert.equal(positionAt(playing(), T0 + 10_000), 10);
  });

  it('freezes while paused', () => {
    const tl = playing({ paused: true, anchorPos: 42 });
    assert.equal(positionAt(tl, T0 + 60_000), 42);
  });

  it('scales by playback rate', () => {
    assert.equal(positionAt(playing({ rate: 2 }), T0 + 10_000), 20);
    assert.equal(positionAt(playing({ rate: 0.5 }), T0 + 10_000), 5);
  });

  it('reports zero for an idle room', () => {
    assert.equal(positionAt(playing({ source: null }), T0 + 10_000), 0);
  });

  it('never returns a negative position', () => {
    // A client whose clock estimate is badly behind could evaluate before the
    // anchor; it must not hand a negative seek to the player.
    assert.equal(positionAt(playing({ anchorPos: 1 }), T0 - 60_000), 0);
  });

  it('is identical for a late joiner and an existing member', () => {
    // The property the whole design exists for.
    const tl = playing({ anchorPos: 90, anchorAt: T0 + 30_000 });
    const lateJoinerCopy = structuredClone(tl);
    for (const offset of [0, 1_000, 25_000, 120_000]) {
      const at = T0 + 30_000 + offset;
      assert.equal(positionAt(tl, at), positionAt(lateJoinerCopy, at));
    }
  });
});

describe('decideCorrection', () => {
  const base = { buffering: false, confident: true, paused: false };

  it('does nothing inside the dead band', () => {
    assert.deepEqual(decideCorrection(10.0, 10.02, 1, base), { action: 'none' });
    assert.deepEqual(decideCorrection(10.0, 9.98, 1, base), { action: 'none' });
  });

  it('nudges rather than seeking for a small drift', () => {
    const behind = decideCorrection(9.7, 10.0, 1, base);
    assert.equal(behind.action, 'nudge');
    // Behind → speed up.
    assert.ok(behind.action === 'nudge' && behind.playbackRate > 1);

    const ahead = decideCorrection(10.3, 10.0, 1, base);
    assert.ok(ahead.action === 'nudge' && ahead.playbackRate < 1);
  });

  it('scales the nudge around the current rate, not around 1x', () => {
    const result = decideCorrection(19.7, 20.0, 2, base);
    assert.ok(result.action === 'nudge');
    assert.ok(Math.abs(result.playbackRate - 2 * (1 + SYNC.NUDGE_FACTOR)) < 1e-9);
  });

  it('hard seeks once drift exceeds the threshold', () => {
    const result = decideCorrection(0, 30, 1, base);
    assert.deepEqual(result, { action: 'seek', position: 30 });
  });

  it('treats the band edges consistently', () => {
    // Just under the dead band → nothing; just over → nudge.
    assert.equal(decideCorrection(10, 10 + 0.049, 1, base).action, 'none');
    assert.equal(decideCorrection(10, 10 + 0.051, 1, base).action, 'nudge');
    // Just under the seek threshold → nudge; at it → seek.
    assert.equal(decideCorrection(10, 10 + 1.49, 1, base).action, 'nudge');
    assert.equal(decideCorrection(10, 10 + 1.5, 1, base).action, 'seek');
  });

  it('suppresses all correction while buffering', () => {
    // Otherwise a struggling connection fights its own rebuffer with seeks.
    const opts = { ...base, buffering: true };
    assert.equal(decideCorrection(0, 30, 1, opts).action, 'none');
    assert.equal(decideCorrection(9.7, 10, 1, opts).action, 'none');
  });

  it('suppresses correction while paused', () => {
    assert.equal(decideCorrection(0, 30, 1, { ...base, paused: true }).action, 'none');
  });

  it('withholds fine correction until the clock estimate is trusted', () => {
    const unsure = { ...base, confident: false };
    // A small drift may just be our own clock error — wait.
    assert.equal(decideCorrection(9.7, 10, 1, unsure).action, 'none');
    // A large drift is real regardless of a few hundred ms of clock error.
    assert.equal(decideCorrection(0, 30, 1, unsure).action, 'seek');
  });

  it('ignores non-finite input rather than seeking to NaN', () => {
    assert.equal(decideCorrection(Number.NaN, 10, 1, base).action, 'none');
    assert.equal(decideCorrection(10, Number.POSITIVE_INFINITY, 1, base).action, 'none');
  });
});
