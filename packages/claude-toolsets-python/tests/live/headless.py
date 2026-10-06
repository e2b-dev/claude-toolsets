"""Manual, billable E2B check of where Chrome shows; no model.

On an e2b_desktop sandbox with no options, Chrome opens a visible window on the desktop's screen; with
headless=True it runs headless with no window.
"""

import time

from e2b_desktop import Sandbox

from e2b_claude_toolsets import E2BBrowserToolset, allow_hosts


def main():
    desktop = Sandbox.create(
        timeout=300, network={"allow_public_traffic": False, "mask_request_host": "localhost:${PORT}"}
    )

    def windows():
        out = desktop.commands.run(
            "xdotool search --onlyvisible --class chrome 2>/dev/null | wc -l", envs={"DISPLAY": ":0"}
        )
        return int(out.stdout.strip())

    def headless_chromes():
        out = desktop.commands.run("pgrep -fa '[c]hrome.*--remote-debugging-port' | grep -c -- '--headless' || true")
        return int(out.stdout.strip())

    try:
        with E2BBrowserToolset(sandbox=desktop, url_policy=allow_hosts(["example.com"])):
            assert headless_chromes() == 0, "default on a desktop: Chrome should not be headless"
            assert windows() > 0, "default on a desktop: a Chrome window should be on screen :0"
            print("PASS default on a desktop: visible window, not --headless")
        for _ in range(20):
            if headless_chromes() == 0 and windows() == 0:
                break
            time.sleep(0.25)
        with E2BBrowserToolset(sandbox=desktop, headless=True, url_policy=allow_hosts(["example.com"])):
            assert headless_chromes() == 1, "headless=True: Chrome should run --headless"
            assert windows() == 0, "headless=True: no Chrome window should be on screen"
            print("PASS headless=True: --headless, no window")
    finally:
        desktop.kill()


if __name__ == "__main__":
    main()
