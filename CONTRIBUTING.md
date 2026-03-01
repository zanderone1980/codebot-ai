# Contributing to CodeBot AI

Thank you for your interest in contributing to CodeBot AI! This guide covers everything you need to get started.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/zanderone1980/codebot-ai.git
cd codebot-ai

# Install dev dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type-check without emitting
npm run lint
```

## Project Structure

```
src/
  agent.ts            Core agent loop (streaming, tool execution)
  cli.ts              CLI interface and REPL
  types.ts            TypeScript interfaces
  index.ts            Public API exports
  policy.ts           Policy engine
  audit.ts            Hash-chained audit logging
  metrics.ts          Structured telemetry
  risk.ts             Risk scoring engine
  sarif.ts            SARIF 2.1.0 export
  security.ts         Path safety and validation
  secrets.ts          Secret detection
  telemetry.ts        Token and cost tracking
  tools/              28 built-in tool implementations
  providers/          LLM provider adapters
  context/            Context window management
extensions/vscode/    VS Code extension
actions/codebot/      GitHub Action
docs/                 Documentation
```

## Test Conventions

- **Framework**: Node.js built-in `node:test` + `node:assert` (no external test dependencies)
- **Location**: Co-located test files (`foo.ts` paired with `foo.test.ts`)
- **Run**: `npm test` executes all tests via `node --test`
- **Pattern**: Each test file uses `describe()` and `it()` blocks
- **Mocks**: Use the `MockProvider` pattern from `src/agent.test.ts` for LLM mocking

### Writing Tests

```typescript
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { YourModule } from './your-module';

describe('YourModule', () => {
  it('does something expected', () => {
    const result = new YourModule().doThing();
    assert.strictEqual(result, 'expected');
  });
});
```

## Pull Request Process

1. Fork the repository and create a feature branch
2. Write your changes with tests
3. Ensure `npm test` passes (376+ tests)
4. Ensure `npm run lint` passes (TypeScript strict mode)
5. Submit a PR against `main`
6. Describe your changes clearly in the PR description

## Code Style

- TypeScript strict mode throughout
- Zero runtime dependencies (use Node.js built-ins only for core package)
- Fail-safe design: telemetry, metrics, and audit never throw
- All security-relevant actions logged to audit
- Every new tool needs: implementation, tests, schema, permission level

## Contributor License Agreement

By submitting a pull request, you agree to the terms in [CLA.md](CLA.md). In summary: you grant a perpetual, irrevocable license to use your contributions under the project's MIT license, and you confirm you have the right to make the contribution.

## Code of Conduct

Be respectful, constructive, and professional. We welcome contributors of all experience levels.
