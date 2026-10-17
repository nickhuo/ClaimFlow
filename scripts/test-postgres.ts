const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url)
  throw new Error("Configure TEST_DATABASE_URL or DATABASE_URL for PostgreSQL integration tests.");
const child = Bun.spawn([process.execPath, "test", "tests/postgres-store.test.ts"], {
  env: { ...process.env, TEST_DATABASE_URL: url },
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
export {};
