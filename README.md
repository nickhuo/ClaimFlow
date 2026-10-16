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

## Domain-first development

Start a business change with the terms in [GLOSSARY.md](GLOSSARY.md), concrete scenarios and domain invariants. Implement and test the domain behavior, then connect application contracts and adapters. The dependency direction is recorded in [ADR-0001](docs/adr/0001-domain-first.md) and checked by `tests/architecture.test.ts`.

`Case` owns subject ownership, exact amounts, unknown values and appeal-date interpretation. Document guidance owns material equivalence, original requirements and the treatment of unanchored deadlines. Domain code uses pure TypeScript and receives time explicitly. TypeBox, Pi, environment decoding and fixture formats live outside it.

## Repository contents

- `docs/brief.md`: requirements, workflow, and delivery criteria.
- `docs/sop-rules.md`: phase boundaries, identity/authorization semantics, recovery and defaults.
- `fixtures/`: supplied identity, claims, authorization, and document-guidance test data.
- `GLOSSARY.md` and `docs/adr/`: business vocabulary and architectural decisions.
- `src/domain/`: identity, authorization, cases, documents, facts and conversation models/rules.
- `src/application/tool-contracts.ts`: executable business tool schemas, derived contracts and phase exposure policy.
- `src/application/ports.ts` and `config.ts`: server data/clock requirements and configuration decoding.
- `src/adapters/fixtures/`: validated fixture loading, subject-scoped reads and document mapping; see [fixture data](docs/fixture-data.md).
- `src/adapters/pi/`: isolated Pi session factory and guarded business tool registration.
- `scripts/pi-smoke.ts` and `tests/`: domain, dependency-direction, fixture and SDK checks.

OPC-156 and OPC-157 provide the engineering foundation and fixture data adapter. The running SOP state machine, identity matching/authorization, complete conversational agent, UI and Docker delivery are implemented in the subsequent Linear tasks.
