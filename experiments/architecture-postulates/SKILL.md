---
name: architecture-postulates
description: Architecture postulates — layers and the direction of dependencies, dal as the sole owner of writes, api/workers as the boundary with the outside world, a pure model, subsystems, interfaces, tests, growth and conventions. Load when designing or reviewing the structure of a system.
---

# Architecture postulates

## 1. Layers and the direction of dependencies

1. The zones of a service and what each is allowed to import from the project:
   - `model` — nothing.
   - `lib` — nothing from the service zones (only external libraries and the
     repository's root `lib`).
   - `integrations` — nothing from the service zones; packages of pure
     "model ↔ provider" conversions next to a client — additionally `model`.
   - `conv` — `model`, the public `_model` packages of subsystems, and DTOs.
   - `dal` — `model`, `lib`, the database client.
   - `middleware` — `model`, `dal`.
   - `api` — `model`, `dal`, `conv`, `integrations`, `middleware`, `lib`,
     the public packages of subsystems.
   - `workers` — `model`, `dal`, `integrations`, `lib`, the public packages
     of subsystems; references to `api` methods — only as fields of the
     dependency struct (see 3.5), never by import.
   - a subsystem — the same rules between its own layers inside; from the
     root — only `model`, `lib`, `integrations`, the database client; foreign
     actions — as fields of the dependency struct (see 6.1).
   - migrations and the database client — `model`, the public `_model`
     packages of subsystems, the database query language.
   - `app` (assembly) — everything; the only place where the zones are
     joined.
2. Everything not listed is forbidden. In particular: `model` and `lib` know
   about nothing; `dal` knows nothing of DTOs, transport, providers,
   notifications or subsystems; `api` and `workers` do not import each
   other; subsystems do not import the root `dal`, `api`, `workers` or each
   other's internal packages.
3. The top layer is `api` and `workers`. By role they are equal and differ
   only in the source of the signal: `api` — invoked actions (RPC,
   webhooks), `workers` — polling and listening ones (ticks, queues, change
   streams).
4. There is no separate layer of "services" or "shared code with external
   effects".
5. The root directories of a service are architectural zones only. No
   directory named after a domain concept exists at the root.
6. Dependency rules are enforced by the build, not by review. If something
   must not be done, there must be no way to do it: a boundary held only by
   review is not a boundary.

## 2. dal — logic over internal data

1. dal is not a repository but logic and work over data, relieved by the
   upper layers of external effects. Multi-step processes over data —
   conditional transitions, transactions, re-reads, deduplication, fact
   markers, feed events — belong to dal.
2. The only criterion of belonging to dal: the absence of external effects.
   An external effect is any interaction with systems beyond the own
   database (providers, banks, cash registers, communication channels, file
   storage, other services).
3. dal is the sole owner of writes to the model. Outside dal (exceptions:
   the database client and migrations) the following are forbidden: the
   database query language, transactions, direct access to collections.
4. Every mutation is a verb of a domain action with its preconditions
   inside. Generic partial-update operations ("patch", "set a field") do not
   exist: that is interference with the model from outside, not a domain
   action. A narrow action over a single field is allowed, but it is named by
   the verb of the fact, not by the write operation. Rationale: a generic
   write loses the caller's intent — it is unclear what exactly changed,
   precise audit and a feed event are impossible, preconditions and
   protection from races are impossible; all of it then has to be
   reconstructed by heuristics above.
5. Only dal opens transactions.
6. The result of an action is the changed entities. What the upper layer has
   to do in the outside world is expressed as follows:
   - computable secondary data of the model — a small helper method on the
     model;
   - what relates not to the model but to the outcome of this very action
     (which branch fired) — an additional return value of the action. It is
     an ordinary function result, not a layer and not a command.
   The upper layer performs the external effects and records them with a
   separate fact action.
7. Data integrity never relies on a process completing correctly. Every
   multi-step operation is either atomic (a transaction) or resumable by a
   worker from a fact marker; the window between writes is a normal
   scenario, not an exception.

## 3. api and workers — the boundary with the outside world

1. The order of work in `api`: session and permissions → input validation →
   preparation → the call into dal (and external effects based on its
   result) → conversion to DTO. `api` contains no query language, no
   transactions and no logic over data that is absent from dal. A
   "read — check — write" sequence discovered above means a missing dal
   action; the action is added, not a write from outside.
2. `workers`: selection of the backlog through dal (age threshold, limit,
   index) → the same dal action as on the synchronous path. A worker
   contains no business logic that the synchronous path lacks.
3. External effects are idempotent by key: the provider's idempotency key
   and a fact marker in dal.
4. Permission-check helpers live together with the session in the
   intermediate layer (`middleware`).
5. A shared upper-layer procedure — a bundle of external effects around dal
   actions, needed by both `api` and `workers` — lives at its primary
   synchronous entry in `api` as an exported method of the service. A worker
   that repeats or completes it does not import the `api` package: it
   receives a reference to the concrete method as a field of the dependency
   struct assembled at application start. No interfaces are introduced for
   this. This is explicit passing of dependencies through a constructor — a
   direct and observable data flow; dependency-injection containers and
   frameworks are not used.
6. A procedure with a single caller lives with that caller. A call to a
   provider with no dal actions around it (reference data, validation of
   external identifiers) is made directly: the integration client plus pure
   conversions.

## 4. model — the types and pure functions of the domain

1. Invariants, state transitions, distributions of amounts, calculations —
   pure functions without I/O, verified by unit tests.
2. `model` is pure: handling of data formats (markup, parsers) is not
   `model`.
3. Methods on model types are allowed only as pure computations over their
   own fields (secondary data, state predicates). There are no methods with
   I/O, storage access or a process on the model.

## 5. lib, integrations, conv

1. The repository's root `lib` holds cross-service libraries. A service's
   own `lib` holds independent service-level libraries with no knowledge of
   the domain. Domain parameters stay with the caller. Do not overuse: only
   what knows nothing of the model goes into `lib`.
2. `integrations` are clients of external APIs with no knowledge of the
   model. "Model ↔ provider" conversions are pure adapters in separate
   packages next to the client. Rules that belong to the provider's protocol
   (not to the domain) are implemented in the client.
3. Interfaces "for a future second provider" are not introduced; they appear
   together with the second provider.
4. `conv` is the only place where the model is converted to DTOs and back.
   Conversions are purely functional and, where possible, return no errors;
   a conversion error is a sign of unvalidated input above.

## 6. subsystems — separated fragments of the system

1. The criterion of separation (the concept is new, the criteria are being
   refined):
   - a module is (almost) self-sufficient and touches the global domain
     minimally → a subsystem with explicit method-level dependencies passed
     into the constructor;
   - a module has access to the whole domain (a projection of the entire
     domain) → a subsystem with explicit dal-level dependencies passed into
     the constructor.
   A module over root collections with the root model is not a subsystem —
   that is the territory of the root dal.
2. A subsystem is the same layered structure in miniature: its own
   `model` / `dal` / `conv` / `api` / `workers` (those it needs), not a
   "service with interfaces". A subsystem layer is created only when it has
   content; there are no empty layers "for symmetry".
3. Package naming: a package used from outside the subsystem carries the
   subsystem's prefix; an internal package has the standard layer name.
   Public roles:
   - `<subsystem>_dal` — public actions over data; if the dal entities
     naturally split into external and internal — two packages, `dal` and
     `<subsystem>_dal`;
   - `<subsystem>_model` — public types and configuration;
   - `<subsystem>_grpc` (and internal transport) — the subsystem's api,
     located inside the subsystem, not in the root `api`;
   - `<subsystem>_workers` — the subsystem's workers;
   - `<subsystem>_facade` — only when an external facade cannot be avoided:
     behind the entry stands the work of the subsystem's upper layer
     (assembly from a domain event and a write; a synchronous send with an
     external effect). Called from the root `api`/`workers`. If the entry
     naturally fits into `_dal`, no facade is created.
4. A subsystem is the sole owner of its collections and of the types of
   their documents (they live in the subsystem's `model`). Root code that
   needs this data is a client of the subsystem's public packages.
5. A subsystem reads root collections with its own dal through the root
   `model` as a shared vocabulary; it does not import the root `dal`.
   Identifiers of root-domain entities are passed by the caller. A
   subsystem importing the root `model` does not violate the rule "dal
   modules do not import each other": what is shared is the vocabulary of
   types, not access to data.
6. A field of a root entity owned only by a subsystem (its marker, its
   index) is written by the subsystem itself — with an explicit note in the
   subsystem's specification.
7. A call into a subsystem from the root is made from the upper layer after
   the root dal action, idempotently, and is completed by a root fact
   action. The subsystem is always present: "not connected" checks do not
   exist.
8. Migrations of a subsystem's collections live inside the subsystem and
   register with the common runner. The subsystem's indexes belong to the
   subsystem.
9. Test instrumentation of the test bench may, when needed, address the
   public packages of subsystems directly.

## 7. Interfaces

1. An interface is a tool of polymorphism: several production
   implementations of one role. An interface is not used for encapsulation
   or for substitution in tests; an interface with a single implementation
   and a stub in a test is a violation.
2. Providers of one kind (for example, message delivery channels) are
   polymorphic by nature — their interfaces are legitimate. A stub
   implementation in place of an unconfigured provider is a crutch, not a
   second implementation: an attempt to use an unconfigured provider is a
   warning and a terminal result of the operation.

## 8. Tests

1. Pure functions — unit tests next to the code.
2. Everything that cannot be properly verified without stubs is verified
   integrationally with real dependencies: the whole bench with doubles of
   the outside world, or subsystem tests on a real database with real
   documents. Storage stubs are not used. A unit test with a real DBMS in a
   container is still a unit test.
3. Functional packages — ordinary unit tests; stateful modules — scenario
   tests that read as a description of usage.

## 9. Growth, legacy, simplicity

1. Not a single query without an index and without a bound on time or size;
   not a single operation over the whole history in periodic workers; not a
   single external call on the main path that the business operation does
   not require.
2. Not a single branch "for old documents": data is brought up to date by a
   migration once, the code knows only the new shape. "Old shape" marker
   values (nil pointers, default substitutions in queries) are forbidden.
3. A solution is the minimal mechanism that closes the invariant: a
   conditional write and an idempotent worker instead of leases and
   protocols; a fact marker instead of scanning the history.

## 10. Conventions

1. A package has no global state; the only exception is tests.
2. A constructor is a package-level function: `New` when the package has one
   entity, `New<Entity>` when it has several.
3. Every conditional group (`api`, `workers`, `dal`, …) is its own directory;
   a concrete handler, worker or dal entity is its own subpackage or a file
   with the group's prefix.
4. Names of top-level symbols are strictly readable; the packages `common`,
   `utils`, `types`, `pkg`, `meta` do not exist.
5. The scope and lifetime of a declaration are the smallest possible; the
   smaller the scope, the shorter the name.
6. Errors are typed, handled and reported at the moment they occur; the
   system cannot fail silently; terminating the process (`os.Exit`,
   `log.Fatal`) outside the entry point is not used.
