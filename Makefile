.PHONY: run test test-verbose lint lint-fix site serve-site install-hooks clean

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

site:
	python scripts/build_site.py

serve-site: site
	python -m http.server 8000 --directory dist/site

install-hooks:
	bash scripts/install_git_hooks.sh

clean:
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf build dist .pytest_cache .ruff_cache .coverage coverage.xml htmlcov
