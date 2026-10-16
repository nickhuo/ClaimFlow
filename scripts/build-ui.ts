import { fileURLToPath } from "node:url";

export async function buildUi() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = await Bun.build({
    entrypoints: [`${root}src/ui/app.tsx`],
    outdir: `${root}dist`,
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new Error("UI build failed");
  await Bun.write(`${root}dist/index.html`, Bun.file(`${root}src/ui/index.html`));
}
if (import.meta.main) await buildUi();
