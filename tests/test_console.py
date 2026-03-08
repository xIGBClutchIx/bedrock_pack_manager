from bedrock_pack_installer.console import AppState, error, info, ok, print_warnings, section, subsection, warn


def test_console_helpers_print_expected_output(capsys):
    state = AppState()

    warn(state, "warn msg")
    error("error msg")
    ok("ok msg")
    info("info msg")
    section("Section")
    subsection("Subsection")
    print_warnings(state.warnings)

    output = capsys.readouterr().out
    assert "warn msg" in output
    assert "error msg" in output
    assert "ok msg" in output
    assert "info msg" in output
    assert "Section" in output
    assert "Subsection" in output
    assert "Warnings (1)" in output


def test_print_warnings_is_noop_for_empty_list(capsys):
    print_warnings([])
    assert capsys.readouterr().out == ""
