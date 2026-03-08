import sys

from bedrock_pack_installer.cli import parse_args
import bedrock_pack_installer.cli as cli


def test_parse_args_defaults_to_no_flags():
    args = parse_args([])

    assert args.rebuild is False
    assert args.zip is False
    assert args.beta is False


def test_parse_args_accepts_combined_flags():
    args = parse_args(["--rebuild", "--beta", "--zip"])

    assert args.rebuild is True
    assert args.beta is True
    assert args.zip is True


def test_configure_output_uses_reconfigure_when_available(monkeypatch):
    calls = []

    class FakeStream:
        def reconfigure(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(sys, "stdout", FakeStream())
    monkeypatch.setattr(sys, "stderr", FakeStream())

    cli.configure_output()

    assert calls == [
        {"encoding": "utf-8", "errors": "replace"},
        {"encoding": "utf-8", "errors": "replace"},
    ]
