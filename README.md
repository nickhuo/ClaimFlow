# ClaimFlow

Conversational insurance claims support with an explicit SOP controller, protected-data gates, cross-phase memory, and optional email follow-up.

The project uses TypeScript throughout, Bun for its runtime, dependencies, scripts, and tests, and Pi SDK as its agent harness. The requirements and workflow are in the [project brief](docs/brief.md); the implementation contracts are in [SOP rules](docs/sop-rules.md).

## Development

Requires Bun 1.2.18 or later. Pi SDK and Pi AI are pinned to 1.3.0 in `package.json` and `bun.lock`.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run smoke
```

The smoke uses Pi's fake provider with a real SDK session and tool loop. It performs no model requests over the network and needs no API token. `bun run dev` runs this smoke in watch mode while the application is being built.

`.env.example` lists the proposed business-policy defaults and future real-model settings. Copy it to `.env` when configuring a host; pass the provider, model, token and prompt explicitly to `createSession`. Tokens stay server-side. The current factory creates isolated, in-memory Pi conversations and loads only explicitly registered business tools and host resources.

## Repository contents

- `docs/brief.md`: requirements, workflow, and delivery criteria.
- `docs/sop-rules.md`: phase boundaries, identity/authorization semantics, recovery and defaults.
- `fixtures/`: supplied identity, claims, authorization, and document-guidance test data.
- `src/sop/`: domain types and identity evidence/configuration policy.
- `src/tools/contracts.ts`: business tool inputs, outputs and phase exposure policy.
- `src/adapters/pi/`: isolated Pi session factory and guarded business tool registration.
- `scripts/pi-smoke.ts` and `tests/`: offline SDK smoke and foundation checks.

This is the engineering foundation for OPC-156. Fixture services, the running SOP state machine, complete conversational agent, UI and Docker delivery are implemented in the subsequent Linear tasks.
