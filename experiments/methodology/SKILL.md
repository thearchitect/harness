---
name: methodology
description: Software engineering methodology: good sense over process, subconscious understandability, simplicity and minimalism, SRP, explicitness, strongest contracts, dependency hygiene; general and application architecture, code style, technical debt, investigation, docs, glossary. Load when designing a system or judging an architectural or code-structure decision.
---

# Methodology

## General principles

### The Good Sense Rule

Your main tool in the field.

- Any principle could be dropped/avoided/changed **situationally** according to the rule
- Prefer good sense over formal process

### Try to maintain subconscious-understandability of your code and architecture

Software engineering is about engineers, not machines.
Always remember it designing your software.
The architecture you develop should be subconsciously-understandable by a human on all levels.
Most of the guide is about it.

### Simplicity and Minimalism

TODO: +SRP; Simple and minimal architecture/code/codebase structure is a key to understandability and stability.
So if you can achieve same result with fewer code/modules - do it.

- No overgeneralization
- No pattern juggling
- Less code
- Smaller and shallower CFG
- Smaller and shallower DFG
- Smaller dependency graph
- Smaller scopes
- Shorter lifetimes
- Smaller and shallower project tree
- Fewer entity classes/types
- Fewer entities
- Fewer modules
- Fewer layers
- Fewer services
- Fewer dependencies

### SRP (Single Responsibility Principle)

- Works in both directions
  - One module is responsible for one and only one function
  - One function is implemented by only one module
- Applies to all levels — From small internal modules to services

### Maximum decomposition level possible

If you can draw a dividing line, without sacrificing **simplicity** and **SRP** - draw it.

### Maximum explicitness and straightforwardness

Your solutions should be implemented the most straightforward way
(i.e. no Dependency Injection containers/frameworks;
explicit constructor-passed dependencies are the way to achieve explicitness)

### Strongest contract possible

Every statement you make should be described in a form of executable and non-executable code

- Non-executable contract — i.e. code-first DAO, readable method signatures, class/interface/structure definitions, protobuf definitions, etc.
- Executable contract

### Dependency hygiene

it's better to write few (even hundreds) lines of code to solve the problem
than introduce a 3rd party solution, that you will need to learn and depend on, struggling with its limitations.
Introduce only high quality dependencies

### No impractical decisions

If you decision leads to no direct practical positive effect - avoid it

### No blind best-practice following

Best-practice applied "just in case" or "just because" is a worst-practice. (i.e. 'Repository' pattern)

### TODO: Technical Debt

### TODO: Observability

### TODO: Consistency

Must always present at 100% level (be it immediate or eventual)

### Beware of the **False Simplicity**

Some techniques offers false simplicity. Be smart and avoid them.

- Untyped languages — *they are not simpler, they are less specific, thus more complex*
- Schema less approaches of any kind — also simply less specific, you always have schema, the question is: is it recorded/enforced or not?
- CRUD methods — loss of specificity
- "Do fast then refactor" approach — know how? do now!
- Dependency Injection containers/frameworks
  simply makes data flow less obvious, thus more complex.
  Explicit dependencies passed through constructors are not DI in this sense - they are explicitness.
- GraphQL — gives you too much freedom; less freedom - more control; harder to optimize

### Systems developed according to these principles

- Has better stability
- Has better maintainability
- Requires fewer engineering resources
- Give engineers ability of faster onboarding
- Requires low test coverage to be stable
- Requires no debugger (and a debugging process at all) to find a problem
  A mark of a high quality system:
  You can determine a problem by looking only at a stacktrace and error description
  to know exact error and reason
- Easier to understand

### Some general notes

- Technologies should not be just comfortable to use for your team - they should be comfortable to use for your **well-trained** team
- Everyone should write code in a similar style to others
  - Makes work efficient
  - Speeds up onboarding
  - Speeds up switching
- If something could be automated - it should be automated
- If something could be simplified - it should be simplified
  - Support costs depend on quality and simplicity
- Dirty hacks during prototyping ("do fast then refactor" myth) emerge because of laziness and lack of knowledge. Do it right from the beginning! (if it's not a presentation mockup)
- The proposition that building a general-purpose system is a more complex task is a myth; on a distant prospect, general-purpose systems are easier to extend and maintain

## General Architecture

### Steps

- Design
  - Understand the domain
  - Gather requirements
  - Imagine your system after 5 years in production
  - Initial architecture papers
- Model
  - DTO / API
  - DAO
  - Code Infrastructure
  - Benchmarks for predicted corner cases?
- Development
  - Tests
  - Implementation

### Entities must represent real-world objects

### Architecture developed using deductive approach (top-down)

- No "special cases" — changes we bring should be a part of a common well-designed concept
  - Bad design formula: [work] = [new requirements]
  - Good design formula: [work] = [brand new system design with new requirements] - [current system]
- No fragmentary changes — (new requirements never implemented as-is)
  - They are going through the architecture development process
  - Fragmentary changes clutters architecture and it becomes a bunch-of-special-cases

### Rules of decomposition

- Will separation of this domain/subdomain bring problems/complexities?
- Different workload type
- Different load pattern — (simply. CPU, RAM, DISK, etc usage)
- Different security requirements
- Homogeneous domains should not be split — todo
- Could be decomposed without significant complexity rise
- No premature optimization
  - Optimization could break decomposition, encapsulation and influence architecture
  - So optimizations should be done on the ready-made system
- All modules should be homogeneous
  - If a module implements domain logic on top of a specific database, nothing else here
  - Doing specific data computation? Nothing else here.
  - Doing other kind of computation? Same.
  - Implements FSM that describes a process? Only FSM impl is here. In a separate module.

### Control flow

### Data flow

- Module should have no global state — the only exception is tests, they may have DDL-like appearance
- Scopes should have as few symbols as possible (especially at package scope, especially public ones) — TODO: explanation
- Declarations should have the narrowest possible scope it could have — TODO: explanation

### Polymorphism

- Interface is a polymorphism tool, not an encapsulation tool
- Interfaces != Polymorphism
- Never use polymorphism for encapsulation
- No redundant polymorphism
  - Should be incorporated only when **really** necessary
    Never build polymorphic constructs "just in case".
    Redundant polymorphism bloats application architecture and makes it less readable
  - Adds extra layers
  - Rises complexity
- Method overloading makes code less readable/understandable
- Inheritance
  - Better avoid it

### Encapsulation

- Polymorphism != Encapsulation != Interfaces — Use decomposition and visibility setting for encapsulation
- This is simple
- Being properly decomposed, a module hides its complexity behind its API
- If something should not be done, there should be no way to do it

### Data modeling

- Your DAO must reflect real world
  - Entities should be named accordingly to its predestination and their names should be **subconsciously understandable**
- You should achieve your goals using properly designed DAO, not by using rich query language
  - Good DAO ⇒ simpler queries ⇒ faster system
  - Shift your focus from building awesome queries to building awesome data model ;)
- Model should be defined in a 'clean' way
  means in a separate package with no I/O and no process logic on the model;
  i.e.: classical DAO approach is contrary to this case.
  Pure computations over own fields (derived values, state predicates) are allowed - they are the model, not a DAO.
- Data model should not cross boundaries of it's (sub)domain — i.e.: DAO should not be used as a DTO
- Data model should have exactly one owner — If you need to access someones data - use API; This is what API is built for.
- **Tree data model** is preferred over **Tabular data model** for business domain — If you're disagree, please send CSV in responses from now on
- TODO: Denormalization (+levels)
- Reference entities only by ID
- Each (sub)domain should maintain its own data model, and own it
  - No other service can access this data directly
- Similar entities should be merged into a single entity if: (TODO)
  - Most of the data are similar
  - Non-similar data could be described using some pattern without sacrificing semantics/readability
  - Handling principle is similar (i.e.: most of methods are identical)
  - Structures are similar
  - Structures could be merged without sacrificing semantics/readability
- Data converters
  - Maintain data converters in a separate package
  - Keep it purely functional
  - Make it not return errors (if possible)

### API

- Should be designed first!
- API is the main thing; being properly designed it will be future-proof. Then you can make changes to internal architecture without breaking compatibility.
- API is **data** layer! (not **presentation**) — Presentation logic should influence it as less as possible (unless you design presentation management API)
- TODO: deprecation
- No CRUD — CRUD == loss of specificity and false simplicity; period;
  - For what?
  - No control over which data is actually changed
  - No audit log events /or complex and unreliable diff heuristics
  - Some data modifications require custom logic
  - Data races /or complex concurrency control (forced MVCC)
  - Change state ⇒ update ⇒ What we've changed here, uh???
  - Example: updating user name
    1. client knows that it wants to update user's name
    2. but decides to lose context and sends UpdateUser
    3. server accepts request and analyzes, which data is being changed. Oh sh! He wants to update user name!
    4. server now has to guess preconditions, audit event and concurrency rules for a change it did not name
    5. with RenameUser the intent, the preconditions, the event and the race check are all one explicit action
  - Client already knows what it wants to do.

### Defining how things work. And only then pick technologies.

### Good architecture is superior to raw performance where applicable

### Complexity management

- Complexity management - one of the main purposes of decomposition
- Should be isolated / localized
- Divide your system in two parts
  - The simple one — Familiar structure/patterns
  - The complex one — Well document complex parts

### TODO: Speculative vs Envisional

Speculative engineering vs Previsionary (todo)
Example: with LoadBalancer and BalancingStrategy

### Architecture development process has nothing in common with technology selection

### Good architecture is future-proof

which means most of the improvements have incremental nature
(you only write new code with minimal refactoring)

### When designing something you should extend requirements to fit all future requirements but limit your imagination to real cases

- This means your job is to find the broadest solution with minimum complexity

### 2 modes

- Good design ⇒ Implementation
- Quick prototype ⇒ Validation/testing ⇒ Good design ⇒ Implementation

### Choosing technologies

- TODO
- Prefer language/platform-native solutions if possible

### DAL

- Implements only one thing: data access from a specific database
- DAL is data logic freed from side effects, not a thin repository
  Multi-step data processes (conditional transitions, transactions, dedup, fact markers)
  belong to DAL. Upper layers own side effects (providers, banks, channels) and call DAL actions.
- Could be split to modules
- Modules never import each other
  Sharing the storage model package is not importing a DAL module;
  a subsystem may read another domain's collections with its own DAL through the shared model.
- A specific DAL module accesses only one database
- No polymorphic DALs if not strictly necessary

### Data

- More data
  - All data collected should be ingressed
  - All the data ingressed should be saved
  - All the primary data should be saved unaltered
- **Tree data model** is strongly preferred over **Tabular data model** for business domain
  - Why do we use XML/JSON/YAML in business domain and not CSV?
  - Human consciousness works with vertices and edges
- No duplicated data - except for denormalization — It's fine to denormalize **read-only** data (SAFE), but be careful when making a decision to denormalize **mutable** data (DANGEROUS)

## Reactive Systems Design (todo)

### All data is versioned

### The only way to obtain the data is via **subscription**

### Mutation returns the full modified entity; with all modified dependencies

### Dependencies are not embedded in each other, but returned separately

### On the client side, deps are not embedded, but resolved using store/getters

### Backend decides which data and when it provides to the client

- Backend manages data dependencies

## Application architecture

### General rules

### Executable module design

- Routing should be FLAT and declared in entrypoint to be easily reachable and readable
- TODO: error handling / middleware
- Entry point should should reside in a separate library package — to be callable from anywhere (i.e. tests)
- Entry point should be as small as possible. It’s only a glue for subordinate entities.
- All service-wide entities should be instantiated in the entry point and passed through the call stack — i.e.: logger, data access layer instance, etc
- Proper lifecycle management
  - At the very beginning of the entry point we should have a global Context object instantiated
    Later this object should be passed through the call stack accompanying the control flow.
    This object should be nested and passed to every HTTP/gRPC/etc handler call using specific middlewares or http.Server.BaseContext callback in case of HTTP server.
  - Every service’s entry point should handle SIGINT|SIGTERM|SIGKILL — When the signal is caught, it should cancel the global context to initiate graceful shutdown
  - Graceful shutdown
    - The graceful shutdown should be implemented by every internal process.
    - During the graceful shutdown entry point should wait for them to finish (with timeout).
    - Graceful shutdown process should have a reasonable timeout, to not last forever.
    - System/data integrity should never rely on graceful shutdown — hence atomic writes or resumable-by-marker workers for every multi-step operation
- Handlers
  - Handlers should be thin. — Most of the logic should be encapsulated into a subordinate entities.
  - Handlers should be bound to a structs (except some special cases)

### Library design

- When to decompose function into a separate library? — If it should be used in another service (even if service does not exists yet)
- Every entity should have a constructor defined as a package level function
  - If there is the only entity in a package, then the constructor function should be named New
  - If there are multiple entities in a package, then constructor functions should be named New%EntityName%

### Testing

- Types
  - Reference — Simple test used mainly to demonstrate common usage patterns of a tested system
  - Positive
  - Negative
  - Regression
- Tests should be super-readable
- Functional packages are tested using regular unit style
- Stateful modules are tested in a BDD style — this services two purposes:
  - It provides module's API usage scenario
  - It tests module's API in scenario-way, as it's designed
- Redundant mocking is an evil
  - Why? — It bloats code, overcomplicates architecture, mitigates testing efficiency, wastes time.
    - You spend time to write mock
    - Or you introduce a complex dependency
    - But your mock's behaviour differs from the original dependency behaviour
      Thus mitigates testing efficiency.
      (behaviour of your system running with original dependency could produce errors not covered by test made with mock)
    - You have more code in a codebase
    - You bloat application architecture and sacrifice simplicity — By introducing redundant layers and redundant polymorphism
    - And then your spend more time to support/improve this mock
  - So it can be applied only if there is no other solutions.
    If your unit requires to run alongside a DBMS in docker/compose to test it - run it.
    Unit test with DBMS dependency is still a unit test.
  - If there is no other solutions, it should be applied
  - Storage mocks are never used
    If a unit cannot be tested without a mock, it is tested as an integration test
    against real dependencies (service-level tests/ or repo-level integration tests/).
- Redundant tests are evil also
  This is not true for mission-critical systems,
  no test is redundant for them.
- Developers do manual testing!
  - You developed a feature.
  - You are the author and know the edge cases.
  - Test it briefly in UI.
  - You may find: errors, UX inconsistencies, unexpected behaviour, etc.
- DDL - better
- BDD - more descriptive
- Tests as docs

## Code style and conventions

### Coding Practices

- Maximum function purity!
  - If a method is not pure enough, mutated args go first; method name must contain a `_Mutate` suffix
- Top level symbols (functions, structs/classes) should have exceptionally readable names. [-] — *No 'common', 'dry', 'kiss', 'pkg', 'types', 'lib', 'meta', etc packages*

### Variables naming

- Smaller scope => Shorter name
- No premature variable declaration — This widens and hardens understanding it's scope and lifetime

### Error handling

- If you need more than 10 minutes to find the exact error cause, then something is really bad with your code
- All errors should be handled
- All errors should be reported at the moment they emerge
- System should be designed the way it CAN'T fail silently
- Functions that ask the OS to terminate the process should not be used
  - i.e.: Golang's `os.Exit()` and `log.Fatal()`.
  - These calls prevent the application from calling deinitialisation logic.
- Errors should be typed

### Logging / tracing (TODO)

- Logging, tracing, error handling - one tightly coupled system

### Structure

- Basic/conventional/regulated entities
  - Almost every project contains limited amount of entity types:
    - entrypoint — top-level executable package
    - entrypoint (as a package) — package: 'app'
    - storage data model — package: 'model'
    - data access layer — package: 'dal'
    - model <-> DTO converters — package: 'conv'
    - api implementations — package: 'api'
    - workers — package: 'workers'
    - request middleware (session, authorization helpers) — package: 'middleware'
    - integrations — package: 'integrations'
    - service-level domain-agnostic libraries — package: 'lib'
    - subsystems — package: 'subsystems'; each one repeats the conventional structure in miniature
  - Each conventional entity group should be represented by it's own package at the top level of the repo
  - Each member of a group is a subpackage (directory per handler group / worker); small members may be files prefixed with the group name — i.e.: workers/session_ttl/ and dal/dal_user.go
- Non-conventional elements

## Technical Debt & Refactoring

### Technical Debt

- Elimination starts from global deductive architecture reassessment
  - Only when you have the new reference architecture you can start debt elimination
- Remember - sometimes refactoring consumes more time than an 80% rewrite

### Refactoring

- Must be a continuous process
- Must be never postponed

## Investigation

### Always start investigation from the place where the problem was detected

## Docs

### No redundant docs - only non-obvious things should be documented

### Entrypoint document

- Covers 80% of high-level system knowledge
- Services
- Link to DAO model
- Link to DTO model
- Hacks / known issues list
- Deployment requirements (envVars, affinity, dependencies, general requirements, etc.)
- Patterns and their implementations used project-wide (grouped by repository)
- Key architecture concepts (streams, ...)

### Code as docs first

### Only unobvious things should be documented

## Glossary

### SRP

Single Responsibility Principle

### CFG

Control Flow Graph

### DFG

Data Flow Graph

### DAL

Data Access Layer

### DAO

aka **Storage Model**
Data Access Object, a model used to describe data stored in DBMS.
It this guide's context, it's a simple definition, contrary classical DAO pattern implementation

### DTO

aka **Exchange Model**
Data Transfer Object, a plain model used to describe objects that travels via network APIs.

### BDD

Behaviour Driven Development. In this guide this term is applied only to BDD-styled tests.

### TDD

Test Driven Development

### DDL

Domain Definition Language

### CQRS

### DDD

Dildo Driven Development

### HaBaDD

HAppypath BAsed Development Disease

### DRY, KISS, SOLID, SOC, YAGNI, BDUF

TODODO
