import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from anthropic.tools import ToolError

from e2b_claude_toolsets._browser import E2BBrowserToolset
from e2b_claude_toolsets._scripts import REF_BLOCK_SIZE, expression, runtime_result


class RuntimeContractTests(unittest.TestCase):
    def test_generated_asset_checksum(self):
        import e2b_claude_toolsets

        assets = Path(e2b_claude_toolsets.__file__).with_name("_runtime")
        manifest = json.loads((assets / "manifest.json").read_text())
        self.assertEqual(hashlib.sha256((assets / "runtime.js").read_bytes()).hexdigest(), manifest["sha256"])

    def test_arguments_remain_json_data(self):
        args = {"ref": "ref_1", "value": '"}); .call(\\\nGrüße', "base": 1}
        script = expression("form_input", args)
        request = json.loads(script.splitlines()[-1].split(".call(", 1)[1][:-1])
        self.assertEqual(request, {"operation": "form_input", "args": args})
        with self.assertRaises(ValueError):
            expression("form_input", {**args, "value": float("nan")})

    def test_rejects_malformed_results(self):
        for value in (
            None,
            "ERROR: old format",
            {"ok": True, "value": "text", "nextRef": True},
            {"ok": True, "value": "text", "nextRef": 0},
            {"ok": True, "value": "text", "nextRef": 2**53},
            {"ok": True, "nextRef": 1},
            {"ok": False, "error": "old format", "nextRef": 1},
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime_result(value)

    def test_adapter_does_not_reclaim_reserved_refs_after_an_error(self):
        browser = object.__new__(E2BBrowserToolset)
        browser._ref_next = 3
        result = {"ok": False, "error": {"code": "action_failed", "message": "covered by ref_8"}, "nextRef": 9}
        base = browser._reserve_refs()
        with patch.object(browser, "_run", return_value=result), self.assertRaisesRegex(ToolError, "covered by ref_8"):
            browser._page_call(None, expression("find", {"query": "button", "base": base}))
        self.assertEqual(browser._reserve_refs(), base + REF_BLOCK_SIZE)

    def test_transport_failure_or_invalid_response_never_reuses_reserved_refs(self):
        for response in (ToolError("lost reply"), {"ok": True}):
            browser = object.__new__(E2BBrowserToolset)
            browser._ref_next = 1
            base = browser._reserve_refs()
            with patch.object(browser, "_run") as run, self.assertRaises(ToolError):
                if isinstance(response, Exception):
                    run.side_effect = response
                else:
                    run.return_value = response
                browser._page_call(None, expression("find", {"query": "button", "base": base}))
            self.assertEqual(browser._reserve_refs(), base + REF_BLOCK_SIZE)

    def test_text_is_not_interpreted_as_an_error(self):
        browser = object.__new__(E2BBrowserToolset)
        browser._ref_next = 3
        result = {"ok": True, "value": "ERROR: literal page text", "nextRef": 3}
        with patch.object(browser, "_run", return_value=result):
            self.assertEqual(browser._page_call(None, ""), "ERROR: literal page text")
