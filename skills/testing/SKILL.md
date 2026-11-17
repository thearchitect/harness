---
name: testing
description: What gets tested and how. Load before proposing, writing, changing or running any test, and before deciding how a change will be verified.
---

# Testing

## What a part of the system is

Every part of the system is of one of these types, by what it is and who depends on it.

### Tested: requirements

| Type | What it is | Who depends on it |
|---|---|---|
| **business rule** | a rule of the domain: prices, limits, permissions, state transitions, validation of input | the product |
| **contract** | what another module, service or client relies on: API, schema, protocol, events, routes | other code |
| **user scenario** | what a user does and the outcome they observe | the user |
| **invariant** | what must always or never hold: a payment is charged once, a secret is never logged, a user sees only their own data | everyone |
| **failure mode** | how a rule, contract or scenario handles errors, timeouts and empty data, including what the user learns of it | everyone |

### Not tested

| Type | What it is | Verified by |
|---|---|---|
| **implementation detail** | the inner workings: which function or hook is called, internal state, call order | review; indirectly by the tests of the requirements |
| **wiring** | code that only connects parts: passing props, registering handlers, dependency injection, composition | the scenario that passes through it |
| **design detail** | wording, styling, layout, animation, the channel of feedback (toast, banner, inline message) | looking at the screen, a screenshot |
| **configuration** | values: timeouts, addresses, constants, flag values | review; loading and validating configuration is a contract |
| **dependency behavior** | what someone else's code guarantees: a framework, a library, an external service | its own tests; our contract with it is tested against a fake |
| **type guarantee** | what the compiler or type checker rules out | the type check |
| **generated code** | clients and servers generated from protobuf, OpenAPI, schemas | the generator; the source of the contract is a contract |
| **observability** | logs, metrics, traces | looking at the telemetry |
| **tooling** | development scripts, CI, build, dev-only tools, storybook | running it |

### Not separate types

| Looks like a type | Is |
|---|---|
| security | invariant (leaks, isolation of data) and business rule (permissions) |
| accessibility | user scenario: roles and accessible names are how a scenario finds its outcome |
| concurrency, idempotency | invariant |
| data migration | contract (the schema after it) and invariant (no data lost) |
| i18n, copy | design detail; a translation present for every key is an invariant where it is checked |
| removed functionality | no type: the requirement leaves with its tests; its absence is tested only when the absence is itself an invariant |

## Testing Rules

- Tests are the product's specification of its requirements: they state what the system must do in each scenario, not record how the code happens to work. A failing test means the code is wrong, unless the requirement is being changed deliberately — never fit an assertion to the output.
- Every requirement is covered, and no test is redundant: each test states a requirement no other test states. Coverage means requirements, failure modes included, not lines. Completeness and minimality are never traded against each other.
- A change of a requirement is a change of its tests, in the same piece of work: extend the test that already owns the requirement — its table, its scenario — and add a new test only for a requirement that has none. A requirement taken out of use takes its tests with it.
- The state to return to after every task: a minimal, complete suite that reads as if it had been written as a whole in advance and the system then built to it.
- The suite is always green and current; a failure unrelated to the task is reported to the operator, never skipped or ignored.
- Two suites: unit — pure, stateless checks next to the module they test, by the language's convention; integration — scenarios in a dedicated directory, run by the project's test harness.
- A task writes the tests of the requirements it adds or changes. Where the tests it changes do not follow these rules, they are brought to them; missing coverage and a wider restructuring are proposed in the plan, not done in passing.

### Test Determinism

- A test is deterministic: the same code gives the same verdict on every run, on any machine, under any load. A flaky test is a bug fixed at its cause — never retried, skipped or given a longer timeout.
- Synchronize on events, never on elapsed time. A test waits for the fact it depends on — a resolved promise, a closed channel, a callback, a record in the store, a message in the queue — never for a `sleep` or a polling interval that is "long enough".
- Time is an input. Logic that depends on time — TTLs, debounce, retries and backoff, deadlines, schedules — takes its clock as a dependency; the test injects a fake clock and advances it explicitly, so a thirty-second wait is checked instantly and identically on every run.
- Asynchronous code exposes its completion: a returned promise or future, a done channel, a flush or drain hook. When the code under test offers no such point, add one to the code instead of guessing its timing in the test.
- Deferred consistency is tested at the moment the system signals convergence, not after a guessed delay.
- A timeout in a test is only a guard against hanging: reaching it is a failure, never the expected path, and no verdict depends on its value.
- Every other source of nondeterminism is pinned the same way: seeded randomness, no reliance on map iteration or scheduling order, no state shared between tests.

### Test Instrumentation

The test harness:
- reports every failure with its full context — the scenario step, inputs, expected and actual values, the logs of the system under test, a screenshot for UI — written to files, so a failure is diagnosed from the report without a rerun;
- runs everything, any one suite, or any single test or scenario;
- serves the operator and the agent alike: one command per run, readable output, reports in a known place;
- can be driven by the agent step by step: bring up the environment, run a scenario to a given step, inspect the state, capture screenshots;
- keeps the development loop fast: isolated tests run in parallel, and nothing waits on time;
- for UI, captures a screenshot of any step on request.
