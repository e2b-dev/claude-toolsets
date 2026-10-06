import type { Sandbox as Desktop } from '@e2b/desktop';
import type { CommandExitError } from 'e2b';
import { localViewer } from './viewer.ts';

/** A live view of a desktop sandbox. `url` is a loopback page: open it on the machine running this code. */
export interface LiveView {
  url: string;
  /** Stop the local viewer and the desktop's stream. If it fails, calling it again retries what is left. */
  stop(): Promise<void>;
}

/**
 * Stream an `@e2b/desktop` sandbox so a person can watch the agent work. Starts the desktop's noVNC stream and serves
 * it on a random loopback URL; the E2B traffic token stays in this process, so the sandbox keeps
 * `allowPublicTraffic: false`. Refused if the desktop already streams: stopping a stream is sandbox-wide.
 */
export async function liveView(desktop: Desktop): Promise<LiveView> {
  if (!desktop.trafficAccessToken)
    throw new Error('liveView needs a private desktop: create it with network.allowPublicTraffic: false');
  // pgrep exits 1 for no match; any other failure is not an answer, so do not take over the stream on it
  const streaming = await desktop.commands.run('pgrep -x x11vnc', { timeoutMs: 5_000 }).then(
    () => true,
    (error: unknown) => {
      // By name, not instanceof: the error comes from @e2b/desktop's copy of e2b, which may not be ours
      if (error instanceof Error && error.name === 'CommandExitError' && (error as CommandExitError).exitCode === 1)
        return false;
      throw error;
    },
  );
  if (streaming) throw new Error('liveView: the desktop already has a VNC stream; use a fresh desktop');
  let local: Awaited<ReturnType<typeof localViewer>> | undefined;
  let streamRunning = true;
  const stop = async () => {
    if (local !== undefined) {
      await local.stop();
      local = undefined;
    }
    if (streamRunning) {
      await desktop.stream.stop();
      streamRunning = false;
    }
  };
  try {
    await desktop.stream.start({ port: 6080, requireAuth: false });
    const remote = new URL(desktop.stream.getUrl({ autoConnect: true, resize: 'scale' }));
    local = await localViewer({
      host: desktop.getHost(6080),
      trafficToken: desktop.trafficAccessToken,
      page: remote.pathname.slice(1) + remote.search,
      websocketRoutes: ['websockify'],
    });
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
  const url = local.url;
  let stopping: Promise<void> | undefined;
  return {
    url,
    stop: () =>
      (stopping ??= stop().catch((error: unknown) => {
        stopping = undefined;
        throw error;
      })),
  };
}
