from bedrock_pack_manager.logger import _prune_old_logs, _strip_ansi, capture_run_logs, log_only


def test_strip_ansi_removes_color_codes():
    assert _strip_ansi("\x1b[92mDone!\x1b[0m") == "Done!"


def test_capture_run_logs_writes_latest_and_timestamped_log(tmp_path):
    logs_dir = tmp_path / "logs"

    with capture_run_logs(logs_dir):
        print("\x1b[92mHello\x1b[0m")

    latest_path = logs_dir / "latest.txt"
    dated_logs = [path for path in logs_dir.glob("*.txt") if path.name != "latest.txt"]

    assert latest_path.exists()
    assert latest_path.read_text(encoding="utf-8").strip() == "Hello"
    assert len(dated_logs) == 1
    assert dated_logs[0].read_text(encoding="utf-8").strip() == "Hello"


def test_log_only_writes_to_log_without_console_output(tmp_path, capsys):
    logs_dir = tmp_path / "logs"

    with capture_run_logs(logs_dir):
        log_only("hidden\n")

    assert capsys.readouterr().out == ""
    assert "hidden" in (logs_dir / "latest.txt").read_text(encoding="utf-8")


def test_prune_old_logs_keeps_latest_file_and_five_timestamped_logs(tmp_path):
    logs_dir = tmp_path / "logs"
    logs_dir.mkdir()

    (logs_dir / "latest.txt").write_text("latest", encoding="utf-8")
    timestamped_logs = []
    for index in range(7):
        log_path = logs_dir / f"2026-03-07_22-5{index}-00.txt"
        log_path.write_text(str(index), encoding="utf-8")
        timestamped_logs.append(log_path)

    _prune_old_logs(logs_dir, keep=5)

    remaining_logs = sorted(path.name for path in logs_dir.glob("*.txt"))
    assert "latest.txt" in remaining_logs
    assert len([name for name in remaining_logs if name != "latest.txt"]) == 5
