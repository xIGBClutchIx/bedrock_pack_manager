.PHONY: run test test-verbose lint lint-fix build-linux build-windows install-hooks clean

run:
	python bedrock_pack_manager.py

test:
	pytest

test-verbose:
	pytest -s

lint:
	ruff check .

lint-fix:
	ruff check . --fix

build-linux:
	bash scripts/build_linux.sh

build-windows:
	pwsh -File scripts/build_windows.ps1

install-hooks:
	bash scripts/install_git_hooks.sh

clean:
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf build dist .pytest_cache .ruff_cache .coverage coverage.xml htmlcov
