/**
 * The commands somebody runs to get a piece of paper.
 *
 * These all write to standard output and take a `--format` of either text or
 * json, because half the time the answer is being read by a person and the
 * other half it is being piped into something else. Nothing here writes to the
 * database.
 */

import * as blasts from '../../db/repositories/blasts.js';
import * as patterns from '../../db/repositories/patterns.js';
import * as sites from '../../db/repositories/sites.js';
import * as monitoring from '../../db/repositories/monitoring.js';
import { createMonitoringService } from '../../services/monitoring.service.js';
import { createMagazineService } from '../../services/magazine.service.js';
import { exportDrillPlan } from '../../domain/drilling/plan-export.js';
import { EXIT, UsageError, required } from '../framework.js';

function emit(io, format, payload, lines) {
  if (format === 'json') {
    io.log(JSON.stringify(payload, null, 2));
    return;
  }
  for (const line of lines) {
    io.log(line);
  }
}

export function reportingCommands({ db, clock, logger }) {
  const monitoringService = createMonitoringService({ db, clock, logger });
  const magazineService = createMagazineService({ db, clock, logger });

  return {
    'blast-report': {
      summary: 'print what is known about one shot',
      usage: '--reference MDW-2025-014 [--format json]',
      options: { reference: 'the shot reference', format: 'text or json' },
      async run({ options, io }) {
        required(options, ['reference']);
        const blast = blasts.findBlastByReference(db, options.reference);
        if (!blast) {
          io.error(`there is no shot with reference ${options.reference}`);
          return EXIT.notFound;
        }
        const events = blasts.eventsFor(db, blast.id);
        const decks = blasts.decksFor(db, blast.id);
        const monitored = monitoring.listRecords(db, blast.siteId, { blastId: blast.id });
        emit(io, options.format, { blast, events, decks, records: monitored }, [
          `shot ${blast.reference}`,
          `state: ${blast.state}`,
          `fired: ${blast.firedAt ?? 'not yet'}`,
          `holes: ${blast.holeCount ?? decks.length}`,
          `total charge: ${blast.totalChargeKg ?? 'unknown'} kg`,
          `instantaneous charge: ${blast.instantaneousChargeKg ?? 'unknown'} kg`,
          `events: ${events.length}`,
          `monitor records: ${monitored.length}`,
        ]);
        return EXIT.ok;
      },
    },

    'drill-plan': {
      summary: 'write the drill plan file for a pattern to standard output',
      usage: '--pattern MDW-2025-014 [--layout collar_toe]',
      options: { pattern: 'the pattern reference', layout: 'collar or collar_toe' },
      async run({ options, io }) {
        required(options, ['pattern']);
        const pattern = patterns.findPatternByReference(db, options.pattern);
        if (!pattern) {
          io.error(`there is no pattern with reference ${options.pattern}`);
          return EXIT.notFound;
        }
        const holes = patterns.listHoles(db, pattern.id).map((hole) => ({
          ...hole,
          easting: hole.eastingM,
          northing: hole.northingM,
        }));
        io.log(
          exportDrillPlan(pattern, holes, { format: options.layout ?? 'collar', newline: '\n' }),
        );
        return EXIT.ok;
      },
    },

    compliance: {
      summary: 'judge the monitor records of a period against the receptor limits',
      usage: '--site MDW [--from 2025-01-01] [--to 2025-12-31]',
      options: {
        site: 'the site code',
        from: 'first instant',
        to: 'last instant',
        format: 'text or json',
      },
      async run({ options, io }) {
        required(options, ['site']);
        const site = sites.findSiteByCode(db, options.site);
        if (!site) {
          io.error(`there is no site with code ${options.site}`);
          return EXIT.notFound;
        }
        const assessment = monitoringService.assess({
          siteId: site.id,
          from: options.from,
          to: options.to,
        });
        emit(io, options.format, assessment, [
          `site ${site.code}`,
          `records: ${assessment.recordCount}`,
          `exceedances: ${assessment.exceedances.length}`,
          `worst ratio: ${assessment.summary.worstRatio ?? 'nothing recorded'}`,
          `repeat exceedances: ${assessment.repeats.length}`,
        ]);
        return assessment.summary.compliant ? EXIT.ok : EXIT.refused;
      },
    },

    daybook: {
      summary: 'print the explosives day-book for one magazine and one day',
      usage: '--magazine mag_1 --date 2025-11-03',
      options: {
        magazine: 'the magazine id',
        date: 'the day to print',
        zone: 'the site time zone',
      },
      async run({ options, io }) {
        required(options, ['magazine']);
        const date = options.date ?? clock.date();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new UsageError('--date is a calendar date such as 2025-11-03');
        }
        const magazine = db
          .prepare('SELECT id, site_id AS siteId FROM magazine WHERE id = ?')
          .get(options.magazine);
        if (!magazine) {
          io.error(`there is no magazine ${options.magazine}`);
          return EXIT.notFound;
        }
        const book = magazineService.daybook({
          siteId: magazine.siteId,
          magazineId: magazine.id,
          date,
          zone: options.zone ?? 'UTC',
        });
        io.log(book.csv.trimEnd());
        if (!book.verification.valid) {
          for (const violation of book.verification.violations) {
            io.error(`${violation.rule}: ${violation.message}`);
          }
          return EXIT.refused;
        }
        return EXIT.ok;
      },
    },

    reconcile: {
      summary: 'reconcile what was issued to a shot against what went down the holes',
      usage: '--reference MDW-2025-014',
      options: { reference: 'the shot reference', format: 'text or json' },
      async run({ options, io }) {
        required(options, ['reference']);
        const blast = blasts.findBlastByReference(db, options.reference);
        if (!blast) {
          io.error(`there is no shot with reference ${options.reference}`);
          return EXIT.notFound;
        }
        const reconciliation = magazineService.reconcile({ blastId: blast.id });
        emit(io, options.format, reconciliation, [
          `shot ${blast.reference}`,
          `issued: ${reconciliation.totalIssued} kg`,
          `consumed: ${reconciliation.totalConsumed} kg`,
          `balanced: ${reconciliation.balanced ? 'yes' : 'no'}`,
          ...reconciliation.violations.map(
            (violation) => `  ${violation.rule}: ${violation.message}`,
          ),
        ]);
        return reconciliation.balanced ? EXIT.ok : EXIT.refused;
      },
    },
  };
}
