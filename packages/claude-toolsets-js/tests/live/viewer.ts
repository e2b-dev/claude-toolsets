/** Check the real noVNC viewer receives a desktop framebuffer. */
import { chromium } from 'playwright';
export async function checkViewer(url: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Report asset names/status only; capability URLs and traffic tokens stay private.
    page.on('response', (response) => {
      if (response.status() >= 400)
        console.log('viewer HTTP', response.status(), new URL(response.url()).pathname.split('/').at(-1));
    });
    page.on('pageerror', (error) =>
      console.log('viewer script error', error.message.replace(/https?:\/\/\S+/g, '<url>')),
    );
    page.on('websocket', (socket) => {
      let frames = 0;
      socket.on('framereceived', () => {
        frames++;
      });
      socket.on('close', () => console.log('viewer websocket closed; frames received', frames));
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll('canvas')].some((canvas) => canvas.width === 1280 && canvas.height === 800),
        undefined,
        { timeout: 20_000 },
      );
    } catch {
      console.log(
        'viewer status',
        (await page.locator('body').innerText()).replace(/https?:\/\/\S+/g, '<url>').slice(0, 600),
      );
      throw new Error('Live viewer did not receive a 1280x800 framebuffer');
    }
    console.log('PASS live viewer received 1280x800 framebuffer');
  } finally {
    await browser.close();
  }
}
if (import.meta.main) await checkViewer(process.argv[2]!);
