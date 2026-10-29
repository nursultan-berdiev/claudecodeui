# Vendored tools for the Docker image

The image installs `docli`, the KeyDev CLI for Word (`.docx`) and Excel
(`.xlsx`) files, from a wheel in this folder. The wheel is internal and is not
committed: copy `docli-<version>-py3-none-any.whl` here before
`docker compose build`. When it is missing the build stops at once, before the
slow steps, with `ERROR: docker/vendor/docli-<version>-py3-none-any.whl is
missing` and a pointer to this file.

At KeyDev the wheel is kept in `key_dev_docs/` next to the other internal tools.
