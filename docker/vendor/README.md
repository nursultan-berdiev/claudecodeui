# Vendored tools for the Docker image

The image installs `docli`, the KeyDev CLI for Word (`.docx`) and Excel
(`.xlsx`) files, from a wheel in this folder. The wheel is internal and is not
committed: copy `docli-<version>-py3-none-any.whl` here before
`docker compose build`. The build stops at the `COPY docker/vendor/docli-*.whl`
step when it is missing.

At KeyDev the wheel is kept in `key_dev_docs/` next to the other internal tools.
