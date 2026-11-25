"""Read and search-replace files from the justcode console."""

import re
from pathlib import Path


def read(file: str):
    """
    Read the file at the given path

    `~` for home dir, relative file paths accepted
    """
    return Path(file).expanduser().read_text()


def edit(file: str, old_regex: str, new_exact: str):
    r"""
    Does a search replace editing on the given file.

    Args:
        old_regex: A re.DOTALL regular expression to replace. Use \A and \Z to match the start of a file and end of a file respectively. The file should contain exactly one match. Use raw string (r"<regex>")

        new_exact: The exact string to replace with. Use raw string (r\"\"\"<exact-string>\"\"\")

    Both `old_regex` and `new_exact` should be passed as raw strings (`r` prefixed strings)
    """
    path = Path(file).expanduser()
    with path.open(newline="") as handle:
        text = handle.read()
    found = list(re.finditer(old_regex, text, re.DOTALL))
    if len(found) != 1:
        raise ValueError(f"{path}: expected 1 match, found {len(found)}")
    start, end = found[0].span()
    updated = text[:start] + new_exact + text[end:]
    with path.open("w", newline="") as handle:
        handle.write(updated)
    return updated
