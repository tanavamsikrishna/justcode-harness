"""Persistent console for the justcode harness.

Reads one JSON object per line. A catalog request
(``{"op": "catalog", "dirs": [...]}``) parses top-level function signatures and
docstrings from those directories with ast. It does not import or execute the
modules, and it does not touch the interactive console. A code request
(``{"code": "..."}``) runs in that console and writes ``stdout``, ``stderr``,
and ``exit``. Names survive later code lines. The whole snippet is compiled at
once, so a function and a later statement in one call work. SystemExit is
reported and does not end this process. The parent kills the process on timeout.
"""

import ast
import code
import contextlib
import io
import json
import os
import sys
import tokenize

# The script directory must not shadow the working directory.
sys.path[0] = ""


def linecol_to_offset(source, line, col):
    lines = source.splitlines(keepends=True)
    return sum(len(lines[i]) for i in range(line - 1)) + col


def header_end(source, node):
    """Offset just after the colon that closes the def header."""
    wanted = (node.lineno, node.col_offset)
    started = False
    depth = 0
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if not started:
            if tok.type == tokenize.NAME and tok.string == "def" and tok.start == wanted:
                started = True
            continue
        if tok.string in "([{":
            depth += 1
        elif tok.string in ")]}":
            depth -= 1
        elif tok.string == ":" and depth == 0:
            return linecol_to_offset(source, *tok.end)
    raise ValueError(f"{node.name}: header colon not found")


def docstring_expr(node):
    if not node.body or not isinstance(node.body[0], ast.Expr):
        return None
    value = node.body[0].value
    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        return node.body[0]
    return None


def excerpt(source, node):
    start = linecol_to_offset(source, node.lineno, node.col_offset)
    doc = docstring_expr(node)
    if doc is None or doc.end_lineno is None or doc.end_col_offset is None:
        return source[start : header_end(source, node)]
    end = linecol_to_offset(source, doc.end_lineno, doc.end_col_offset)
    return source[start:end]


def functions_in(path):
    try:
        source = open(path, encoding="utf-8").read()
    except (OSError, UnicodeError):
        return []
    source = source.replace("\r\n", "\n").replace("\r", "\n")
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    found = []
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        found.append({"path": path, "name": node.name, "text": excerpt(source, node)})
    return found


def python_files(directory):
    try:
        names = []
        with os.scandir(directory) as scan:
            for entry in scan:
                if not entry.name.endswith(".py"):
                    continue
                if entry.is_symlink() or entry.is_file(follow_symlinks=False):
                    names.append(entry.name)
    except OSError:
        return []
    return sorted(names)


def catalog_dirs(dirs):
    rows = []
    for directory in dirs:
        if not isinstance(directory, str):
            continue
        for name in python_files(directory):
            rows.extend(functions_in(os.path.join(directory, name)))
    return rows


class Console(code.InteractiveConsole):
    def __init__(self):
        super().__init__({"__name__": "__main__", "__doc__": None})
        self.failed = False

    def showsyntaxerror(self, filename=None):
        self.failed = True
        super().showsyntaxerror(filename)

    def showtraceback(self):
        self.failed = True
        super().showtraceback()


def execute(console, source):
    if source == "":
        return
    try:
        compiled = compile(source, "<input>", "exec")
    except (OverflowError, SyntaxError, ValueError):
        console.showsyntaxerror("<input>")
        return
    console.runcode(compiled)


def reply(stdout, stderr, exit_code):
    print(
        json.dumps({"stdout": stdout, "stderr": stderr, "exit": exit_code}),
        flush=True,
    )


console = Console()
for line in sys.stdin:
    if not line.strip():
        continue
    req = json.loads(line)
    if isinstance(req, dict) and req.get("op") == "catalog":
        dirs = req.get("dirs", [])
        if not isinstance(dirs, list):
            dirs = []
        json.dump(catalog_dirs(dirs), sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()
        continue
    console.failed = False
    stdout, stderr = io.StringIO(), io.StringIO()
    exit_code = 0
    code_text = req.get("code", "") if isinstance(req, dict) else ""
    if not isinstance(code_text, str):
        code_text = ""
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            saved_stdin = sys.stdin
            sys.stdin = io.StringIO()
            try:
                execute(console, code_text)
            finally:
                sys.stdin = saved_stdin
    except SystemExit as err:
        status = err.code
        if isinstance(status, int):
            exit_code = status
        elif status is None:
            exit_code = 0
        else:
            exit_code = 1
            stderr.write(f"{status}\n")
    else:
        exit_code = 1 if console.failed else 0
    reply(stdout.getvalue(), stderr.getvalue(), exit_code)
