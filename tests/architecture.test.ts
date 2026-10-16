import { expect, test } from "bun:test";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const scanner = new Bun.Transpiler({ loader: "ts" });

test("domain dependencies point inward and application never imports an adapter", async () => {
  const violations: string[] = [];
  for (const area of ["domain", "application"]) {
    const directory = resolve(src, area);
    for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: directory })) {
      const file = resolve(directory, path);
      const code = await Bun.file(file).text();
      const imports = new Set(scanner.scanImports(code).map((entry) => entry.path));
      // Runtime scanning erases type-only imports; include their dependency direction too.
      for (const match of code.matchAll(/\b(?:import|export)[^;]*?\bfrom\s*["']([^"']+)["']/g))
        imports.add(match[1]!);
      for (const match of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g))
        imports.add(match[1]!);
      for (const specifier of imports) {
        const allowed = specifier.startsWith(".")
          ? ["domain", ...(area === "application" ? ["application"] : [])].some((target) =>
              resolve(dirname(file), specifier).startsWith(resolve(src, target) + sep),
            )
          : area === "application" && (specifier === "typebox" || specifier.startsWith("typebox/"));
        if (!allowed) violations.push(`${area}/${path} imports ${specifier}`);
      }
      if (area === "domain" && /\b(?:Bun|process|fetch)\s*(?:\.|\()/.test(code))
        violations.push(`${area}/${path} uses ambient I/O`);
      if (area === "domain" && /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)/.test(code))
        violations.push(`${area}/${path} reads ambient time`);
    }
  }
  expect(violations).toEqual([]);
});
