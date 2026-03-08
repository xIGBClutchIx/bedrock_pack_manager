from bedrock_pack_installer.console import (
    AppState,
    TerminalListMenu,
    app_header,
    app_header_lines,
    error,
    info,
    ok,
    print_warnings,
    section,
    subsection,
    warn,
)


def test_console_helpers_print_expected_output(capsys):
    state = AppState()

    warn(state, "warn msg")
    error("error msg")
    ok("ok msg")
    info("info msg")
    app_header()
    section("Section")
    subsection("Subsection")
    print_warnings(state.warnings)

    output = capsys.readouterr().out
    assert "warn msg" in output
    assert "error msg" in output
    assert "ok msg" in output
    assert "info msg" in output
    assert "Bedrock Pack Installer" in output
    assert "Section" in output
    assert "Subsection" in output
    assert "Warnings (1)" in output


def test_print_warnings_is_noop_for_empty_list(capsys):
    print_warnings([])
    assert capsys.readouterr().out == ""


def test_app_header_lines_match_rendered_header(capsys):
    app_header()

    rendered = capsys.readouterr().out.splitlines()
    assert rendered == app_header_lines()


def test_terminal_list_menu_redraws_without_clearing_screen(capsys):
    items = ["first"]
    menu = TerminalListMenu(["header"], lambda: items)

    menu.render_initial()
    items[0] = "second"
    menu.redraw()

    output = capsys.readouterr().out
    assert output.count("\033[2J\033[H") == 1
    assert "\033[1F" in output
    assert "first" in output
    assert "second" in output
