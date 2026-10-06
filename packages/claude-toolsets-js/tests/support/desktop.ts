import { Sandbox, type SandboxOpts } from '@e2b/desktop';
import { liveView, type LiveView } from '../../src/live-view.ts';

/** Stock desktop SDK, native XFCE/noVNC, wrapped only to keep its viewer private. */
export class DesktopSDK {
  private viewer: LiveView | undefined;
  private constructor(readonly sandbox: Sandbox) {}
  static async create(options: SandboxOpts = {}) {
    const sandbox = await Sandbox.create({
      ...options,
      resolution: [1280, 800],
      timeoutMs: options.timeoutMs ?? 600_000,
      network: { ...options.network, allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' },
    });
    return new DesktopSDK(sandbox);
  }
  async startViewer() {
    this.viewer ??= await liveView(this.sandbox);
    return this.viewer.url;
  }
  async kill() {
    try {
      await this.sandbox.kill();
    } finally {
      await this.viewer?.stop();
    }
  }
}
