# Changes

## 1.0.0

The first version that runs a quarry rather than part of one. Everything a shot
touches is in it: the survey, the design, the explosive, the clearance, the
firing, and what happened afterwards.

### The shot

- Face scans, hole layout, real burden per hole and fitting a pattern to the
  shape the bench actually is.
- Charge columns built from the toe up, against the burden that was measured
  rather than the one on the design sheet.
- Tie-in resolution by shortest path, the maximum instantaneous charge as a
  sliding window, and the delay scatter reported both as a bound and as a
  simulation.
- The site law fitted from the site's own monitor records, with the limit curves
  held as data and the allowable charge worked back from them.

### The explosive

- An append only magazine ledger with the day-book generated from it and checked
  against it.
- Batch traceability, shelf life and sleep time, and reconciliation of what was
  issued against what went down the holes.
- Ordering with a reorder point worked out from what has actually been used.

### The day

- The exclusion zone from throw and confinement, sentry cover, and a clearance
  that goes stale on its own.
- Weather, permitted hours and embargoes, competency, and one gate that asks all
  of it at once.
- Post blast inspection, the misfire register, survey, digging and secondary
  breaking.

### The paperwork

- Complaints with a response clock, neighbour notifications, and a reply drafted
  from the record.
- Shot report, period report, productivity, and the regulator return with every
  section present whether or not it has anything in it.

### The parts worth knowing about

- **Consumption does not move the magazine balance.** Found by the end to end
  test, which had the store reading empty twice over.
- **Framework refusals keep their status.** A body over the limit was reading as
  a five hundred, which tells a caller the server is broken rather than the
  request is.
- **The stock check sums in the database.** It was loading every ledger line on
  every movement, which the performance test caught at about two thousand lines.
- **An expired token says so.** The library changed its error code and the
  message had stopped being read.

### Known and deliberate

- Site rules, site laws and prices are versioned rather than edited, so old
  reports keep saying what they said.
- Nothing sends anything anywhere. The jobs report and a person decides.
- The store is a single SQLite file, because this deploys onto one machine in a
  quarry office with no operations team behind it.
