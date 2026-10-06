/** LIVE: exercises every supported computer member on a disposable E2B desktop. */
import { Sandbox } from '@e2b/desktop';
import { E2BComputerToolset } from '../../src/index.ts';

const desktop = await Sandbox.create({
  resolution: [1280, 800],
  timeoutMs: 180_000,
  network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}', denyOut: ['0.0.0.0/0'] },
  metadata: { purpose: 'shared-runtime-live-computer' },
});
try {
  const computer = await E2BComputerToolset.create(desktop, { confirm: () => true });
  try {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['cursor_position', {}],
      ['mouse_move', { coordinate: [400, 300] }],
      ...['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'].map(
        (name): [string, Record<string, unknown>] => [name, { coordinate: [400, 300] }],
      ),
      ['left_mouse_down', {}],
      ['left_mouse_up', {}],
      ['left_click_drag', { start_coordinate: [400, 300], coordinate: [500, 350] }],
      ['scroll', { scroll_direction: 'down', scroll_amount: 1 }],
      ['key', { text: 'Escape' }],
      ['hold_key', { text: 'shift', duration: 1 }],
      ['type', { text: 'E2B exercise' }],
      ['wait', { duration: 0 }],
      ['screenshot', {}],
    ];
    for (const [name, input] of calls) {
      const result = await computer.toolResult({
        type: 'tool_use',
        id: 'exercise',
        toolset_name: 'computer',
        name,
        input,
      });
      if (result.is_error) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
      if (
        name === 'screenshot' &&
        (!Array.isArray(result.content) || !result.content.some((block) => block.type === 'image'))
      )
        throw new Error('Screenshot returned no image');
      console.log('PASS computer', name);
    }
  } finally {
    await computer.close();
  }
} finally {
  await desktop.kill();
  if (await desktop.isRunning()) throw new Error('Test desktop still running');
  console.log('Computer test desktop cleanup verified');
}
