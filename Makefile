.PHONY: run test test-verbose lint lint-fix build-linux build-windows clean

run:
	python bedrock_pack_installer.py

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

clean:
	rm -rf build dist __pycache__ .pytest_cache .coverage coverage.xml *.spec
