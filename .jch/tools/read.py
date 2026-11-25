from pathlib import Path


def read(file: str):
    """
    Read the file at the given path

    `~` for home dir, relative file paths accepted
    """
    return Path(file).expanduser().read_text()
