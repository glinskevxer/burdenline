# How this is put together

Four layers, and the rule between them is one way: the domain knows nothing about
the database or HTTP, the repositories know about the database, the services know
about both, and the routes know about none of the rules.

```
http/routes  →  services  →  db/repositories  →  sqlite
                    ↓              ↓
                 domain  ←────────┘   (plain functions over plain objects)
```

## The domain

Pure functions, no imports from `db` or `http`, no clock of its own. Every module
that can refuse something returns a list of violations rather than throwing on
the first one:

```js
const violations = checkHoleCharge(hole, column, rules);
// [{ rule: 'stemming.minimum', holeNumber: 4, actual: 1.5, required: 2.1 }, ...]
```

The `rule` key is stable and reports group on it. Renaming one silently empties a
section of a compliance report, so they are treated as api.

## The repositories

Functions over an open connection. No ORM, and SQL written out wherever there is
a join. Three tables are append only and have no update function at all: the
magazine ledger, the blast events and the audit trail.

Identifiers and timestamps are set in `createRecord`, in one place, because six
repositories had each written that out and three had drifted.

## The services

They own the order the work is done in, and that order is the interesting part.
The design service runs: lay the pattern out, charge the holes against the burden
that was measured, build the timing over the charged holes, take the
instantaneous charge from the timing, and only then judge the vibration. Doing
the vibration first against a guessed charge produces a design nobody can fire.

## The HTTP layer

Thin by rule. The schemas do the refusing, the one error handler owns every
status code, and each lifecycle move is its own route rather than a patch on a
state field, because a client should ask for a move and the domain should decide.

## What is written down and never edited

| record          | why                                                                  |
| --------------- | -------------------------------------------------------------------- |
| magazine ledger | the legal record; a correction is another line pointing at the first |
| blast events    | the history of a shot survives an edit to the shot row               |
| audit trail     | written in the same transaction as the change it describes           |
| site rules      | a design signed off in March is explained against March's rules      |
| site laws       | a report produced last year can still say which law it used          |

## The tests

`tests/` mirrors `src/`. On top of that:

- `tests/e2e` walks whole flows over HTTP with nothing stubbed. These have found
  a double counted ledger, a stock check loading every line on every movement,
  and framework errors being rendered as five hundreds.
- `tests/performance` guards against a linear read turning quadratic.
- `tests/no-dead-code.test.js` fails on an export nothing calls.
- `tests/helpers/database.js` loads the migrations the application ships, so
  adding one does not mean editing twenty test files.
