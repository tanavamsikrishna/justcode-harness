"""interesting.py -- a tiny universe in <100 lines.

Three scenes, one idea: complex beauty from simple rules, and a
program that can look at itself.

  1. LORENZ   - chaotic attractor (sigma=10, rho=28, beta=8/3)
  2. LIFE     - Conway's Game of Life (birth, survival, death)
  3. ITSELF   - introspection: parse my own source with ast

Run:  python3 interesting.py
"""

import ast
import random
from pathlib import Path

W = 84  # terminal width in cells
H = 24  # terminal height in cells


def lorenz(frames=3):
    print("\n[1] LORENZ - three equations, one butterfly, never repeats")
    print("    dx/dt=sigma(y-x)  dy/dt=x(rho-z)-y  dz/dt=xy-beta*z")
    print("    sigma=10, rho=28, beta=8/3: deterministic, yet chaotic")
    sigma, rho, beta, dt = 10.0, 28.0, 8 / 3, 0.008
    x = y = z = 1.0
    hits = [[0] * W for _ in range(H)]
    shade = " .:*#@"
    for f in range(frames):
        for _ in range(4000):
            x, y, z = (
                x + dt * sigma * (y - x),
                y + dt * (x * (rho - z) - y),
                z + dt * (x * y - beta * z),
            )
            cx = int((x + 22) / 44 * (W - 1))
            cy = int((50 - z) / 50 * (H - 1))
            if 0 <= cx < W and 0 <= cy < H:
                hits[cy][cx] = min(hits[cy][cx] + 1, 5)
        print(f"\n-- orbit segment {f + 1}/{frames}: {(f + 1) * 4000} steps --")
        for row in hits:
            print("".join(shade[v] for v in row))
    print("    x horizontal, z vertical - two lobes, one endless orbit")


def neighbours(grid, x, y):
    return sum(
        grid[(y + dy) % H][(x + dx) % W]
        for dy in (-1, 0, 1)
        for dx in (-1, 0, 1)
        if (dx, dy) != (0, 0)
    )


def life(steps=7):
    print("\n[2] GAME OF LIFE - a cell lives with 2-3 neighbours")
    random.seed(42)
    grid = [[random.random() < 0.16 for _ in range(W)] for _ in range(H)]
    for step in range(steps):
        print(f"\n-- generation {step + 1} --")
        for row in grid:
            print("".join("#" if c else "." for c in row))
        grid = [
            [
                (neighbours(grid, x, y) == 3 or (c and neighbours(grid, x, y) == 2))
                for x, c in enumerate(row)
            ]
            for y, row in enumerate(grid)
        ]


def self_portrait():
    print("\n[3] ITSELF - reading my own source, parsing my own mind")
    src = Path(__file__).read_text(encoding="utf-8")
    tree = ast.parse(src)
    funcs = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]
    print(f"  {len(src.splitlines())} lines, {len(src)} characters")
    print(f"  {len(funcs)} functions defined:")
    for fn in funcs:
        end = getattr(fn, "end_lineno", fn.lineno)
        print(
            f"    - {fn.name}(): {end - fn.lineno + 1} lines, starts at line {fn.lineno}"
        )
    print(
        f"  Most complex function: "
        f"{max(funcs, key=lambda f: getattr(f, 'end_lineno', f.lineno) - f.lineno).name}()"
    )
    me = "self_portrait"
    print(f"  I am {me}, and I just described {me}.")


def main():
    lorenz()
    life()
    self_portrait()
    print("\nSimple rules. No designer. Just iteration.")


if __name__ == "__main__":
    main()
