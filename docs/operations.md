# Running this on a machine in a quarry office

There is one process, one file and no operations team. Everything below assumes
that.

## Starting it

```
docker compose up -d
```

`BURDENLINE_JWT_SECRET` must be set and at least thirty two characters; the
compose file refuses to start without it. The database lives on the
`burdenline-data` volume and is the only writable path in the container.

Migrations run on the way up. A container that starts against a database a
migration behind answers `/ready` with a 503 and says how many are outstanding,
which is the case worth catching: it will otherwise serve requests and write rows
into tables shaped differently from what the code expects.

## The three status routes

| route     | what it tells you                                               | who reads it                           |
| --------- | --------------------------------------------------------------- | -------------------------------------- |
| `/health` | the process is up                                               | the container healthcheck's outer loop |
| `/ready`  | the database answers and the schema matches this build          | the healthcheck, load balancers        |
| `/about`  | which build, which schema, how long up, what is in the database | a person standing at the machine       |

## Backups

```
docker compose --profile backup run --rm backup
```

It uses SQLite's own backup api rather than copying the file, verifies the copy
opens and has tables in it, and only then renames it into place. A copy taken
with `cp` while the server is running may or may not open, and finding out which
during a restore is not the moment.

Keep them off the machine. The whole quarry's blasting record is one file.

## When something is wrong

- **A request is being refused and nobody knows why.** Every problem response
  carries a `requestId`, and every log line for that request carries the same
  one. `burdenline whoami --person <name>` answers the other nine times out of
  ten, which is a role or a certificate.
- **The store and the day-book disagree.** They cannot: the book is generated
  from the ledger. `burdenline daybook --magazine <id> --date <date>` prints the
  book and exits non zero with the specific line if the verification fails.
- **A job has stopped finding things.** `burdenline run-job --name <job>` runs
  the same code path a person can watch. Every job reports what it examined even
  when it found nothing, so a zero from a job that examined nothing is a
  different problem from a zero from a job that examined four hundred records.
- **Something is slow.** The performance tests carry the shapes that were slow
  before: a two hundred and forty hole design and a magazine with a long ledger.
  Run them first rather than guessing.

## What not to do

- Do not edit the ledger, the blast events, the audit trail or a superseded rule
  set. All four are read years later by people asking what was known at the time.
- Do not run two instances against the same database file. SQLite will let you
  and the busy timeout will hide it for a while.
- Do not restore a backup over a running container. Stop it, restore, start it,
  and let the migrations run.
