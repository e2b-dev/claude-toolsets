"""Build page assets from a checkout; reuse packaged assets when building an sdist."""

import hashlib
import json
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class RuntimeBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        root = Path(self.root)
        runtime = root.parent / "claude-toolsets-runtime"
        if (runtime / "build.ts").is_file():
            try:
                subprocess.run(["bun", "build.ts"], cwd=runtime, check=True)
            except FileNotFoundError as error:
                raise RuntimeError("Building from Git requires Bun 1.3.14 and `pnpm install` first") from error

        assets = root / "e2b_claude_toolsets/_runtime"
        for filename in ("runtime.js", "manifest.json", "THIRD_PARTY_LICENSES.txt"):
            if not (assets / filename).is_file():
                raise RuntimeError(f"Missing runtime asset {filename}; run `pnpm build:runtime` before packaging")
        manifest = json.loads((assets / "manifest.json").read_text())
        if hashlib.sha256((assets / "runtime.js").read_bytes()).hexdigest() != manifest["sha256"]:
            raise RuntimeError("Browser runtime checksum mismatch; rebuild the runtime before packaging")
        build_data["artifacts"].append("e2b_claude_toolsets/_runtime/**")
