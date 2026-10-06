import { expect, test } from 'bun:test';
import { liveView } from '../src/index.ts';

test('an inconclusive stream check is not taken as "no stream"', async () => {
  const calls: string[] = [];
  const desktop = {
    trafficAccessToken: 'token',
    commands: { run: async () => Promise.reject(new Error('transport failed')) },
    stream: {
      start: async () => void calls.push('start'),
      stop: async () => void calls.push('stop'),
    },
  };
  await expect(liveView(desktop as never)).rejects.toThrow('transport failed');
  expect(calls).toEqual([]); // neither started nor stopped somebody else's stream
});
