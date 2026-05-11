# burdenline

Drill and blast operations for hard rock quarries.

One shot carries a lot of paper. This is the system that carries it instead: the
face survey and the hole layout, the charge worked back from a powder factor, the
initiation timing and the instantaneous charge that falls out of it, the ground
vibration and airblast that charge implies at every house around the site, the
explosive drawn from the magazine to load it, the clearance that has to hold
before it is fired, and the survey, the cost and the complaints afterwards.

## What is in it

| area       | what it does                                                                   |
| ---------- | ------------------------------------------------------------------------------ |
| geometry   | face scans, hole layout, real burden per hole, fitting a pattern to the bench  |
| charging   | product catalogue, charge columns, powder factor, site charging rules          |
| initiation | delay elements, tie-in resolution, the eight millisecond window, delay scatter |
| vibration  | the fitted site law, the limit curves, allowable charge per receptor, airblast |
| magazine   | append only ledger, batch traceability, the statutory day-book, reconciliation |
| people     | shotfirer certificates, endorsements, who may fire what                        |
| firing     | exclusion zone, clearance that goes stale, weather, permitted hours, the gate  |
| post blast | inspection, misfires, fragmentation, survey, digging, secondary breaking       |
| community  | complaints with a clock on them, neighbour notifications, response letters     |
| supply     | reorder points from real use, orders and deliveries                            |
| reporting  | shot report, period report, the regulator return                               |

## Running it

```
npm install
npm test
npm start
```

Node 20.18 on the 20 line. The store is SQLite at `BURDENLINE_DB`; migrations run
on the way up. `npm run coverage` runs the suite with the coverage floors,
`npm run export-check` installs the tree git actually holds into a clean
directory and starts it there, and `npm run api` regenerates `api.json` from the
routes the server registers.

### The command line

```
npx burdenline help
npx burdenline seed --code MDW        # a demonstration quarry to try things against
npx burdenline drill-plan --pattern MDW-2025-014
npx burdenline compliance --site MDW --from 2026-01-01
npx burdenline supply-review --site MDW
npx burdenline run-job --name stock-sweep
```

Exit codes matter because these run from cron: 0 is fine, 1 is a failure, 2 is
being asked for something that is not there, and 3 is a refusal by a rule.

## The shape of the code

`src/domain` holds the rules and knows nothing about the database or HTTP. Every
module in it is a set of pure functions over plain objects, and every rule that
can refuse something returns a list of violations rather than throwing on the
first one, because a designer fixing one hole at a time is a designer who will be
on the bench until dark.

`src/db` is repositories: functions over an open connection, no ORM, SQL written
out wherever it needs a join. `src/services` puts the domain and the repositories
together in the order the work is actually done. `src/http` is thin: read the
parameters, call the service, hand back what it returned.

Three things are append only and never updated in place: the magazine ledger, the
blast event history and the audit trail. All three are read years later by people
asking what was known at the time, and an edited row cannot answer that.

## Decisions worth knowing about

- **The instantaneous charge is a sliding window, not a bucket.** Two holes eight
  milliseconds apart can land in different buckets and still arrive together.
- **Delay scatter is reported two ways.** The bound is what is physically
  possible and is what a licence condition should be checked against; the
  simulation says how likely anything near it is.
- **The peak is the largest component, not the vector sum.** The standards are
  written per component and substituting the vector sum overstates every event.
- **Consumption does not move the magazine balance.** The issue already took the
  explosive out of the store; the consumption line records what happened to it on
  the bench.
- **Site rules are stored and versioned.** Every default in the domain can be
  overridden per site, and changing one writes a new row rather than editing the
  one that was in force.

## Tests

`tests/` mirrors `src/`, plus `tests/e2e` for whole flows over HTTP and
`tests/performance` for the guards against a linear read turning quadratic. The
end to end tests are the ones that have found the real bugs: a double counted
ledger, an expired token reported as a bad one, and a stock check that was
loading every line in the magazine on every movement.
