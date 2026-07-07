install:
	pip install -e '.[dev]'
run:
	stock-screener --config config/default_config.yaml
test:
	pytest
lint:
	ruff check . && black --check .
format:
	ruff check . --fix && black .
docker-build:
	docker build -t investment-stock-screener .
