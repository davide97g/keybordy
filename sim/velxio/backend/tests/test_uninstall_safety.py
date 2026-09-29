"""Uninstall reports a no-op (arduino-cli exits 0 for a missing library) as a failure."""
from __future__ import annotations

import subprocess
from unittest.mock import patch

import pytest

from app.services.arduino_cli import ArduinoCLIService


class _Result:
    def __init__(self, code: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = code
        self.stdout = stdout
        self.stderr = stderr


@pytest.mark.asyncio
async def test_a_no_op_uninstall_is_reported_as_failure() -> None:
    """arduino-cli exits 0 for a library that is not installed."""
    with patch.object(
        subprocess, "run",
        return_value=_Result(0, "Library Ghost is not installed\n"),
    ):
        out = await ArduinoCLIService().uninstall_library("Ghost")

    assert out["success"] is False
    assert "not installed" in out["error"]


@pytest.mark.asyncio
async def test_a_real_uninstall_still_succeeds() -> None:
    with patch.object(subprocess, "run", return_value=_Result(0, "Uninstalling Real\n")):
        out = await ArduinoCLIService().uninstall_library("Real")
    assert out["success"] is True


@pytest.mark.asyncio
async def test_an_unrelated_not_found_in_output_does_not_fake_a_no_op() -> None:
    """'not found' alone is too broad to mean 'nothing was removed'."""
    with patch.object(
        subprocess, "run",
        return_value=_Result(0, "Uninstalling Real\nwarning: changelog not found\n"),
    ):
        out = await ArduinoCLIService().uninstall_library("Real")
    assert out["success"] is True
