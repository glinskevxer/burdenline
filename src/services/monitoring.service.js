/**
 * Monitor records, from the memory stick to the compliance report.
 *
 * The sequence is import, match to a shot, judge against the receptor limits,
 * and refit the site law. Matching is by time because no monitor writes the shot
 * reference, and it is left as a suggestion rather than applied silently when
 * two shots were close enough together to be confused.
 *
 * Refitting is deliberately manual. A law that refits itself on every import
 * drifts on a run of quiet records and nobody notices until a design is signed
 * off against a law fitted to nothing much.
 */

import { ValidationError, ConflictError } from '../lib/errors.js';
import { importRecords as readVendorFile } from '../domain/monitoring/vendor-imports.js';
import { matchToBlast, usableForFit } from '../domain/monitoring/records.js';
import {
  evaluateAll,
  exceedances,
  repeatExceedances,
  complianceSummary,
} from '../domain/monitoring/compliance.js';
import { fitSiteLaw, upperBound } from '../domain/vibration/site-law.js';
import * as monitoring from '../db/repositories/monitoring.js';
import * as blasts from '../db/repositories/blasts.js';

export function createMonitoringService({ db, clock, logger }) {
  const context = { clock };

  /** Read a vendor file and store what is in it. */
  function ingest({
    siteId,
    text,
    receptorId = null,
    distanceM = null,
    format,
    sourceFile = null,
  }) {
    const parsed = readVendorFile(text, { format, receptorId, distanceM });
    const stored = monitoring.importRecords(db, siteId, parsed.records, { clock, sourceFile });
    logger?.info?.(
      { siteId, format: parsed.format, inserted: stored.inserted, duplicates: stored.duplicates },
      'monitor records imported',
    );
    return { format: parsed.format, ...stored, read: parsed.count };
  }

  /** Suggest a shot for every record that has none, without attaching anything. */
  function suggestMatches({ siteId, from, to, toleranceSeconds = 120 }) {
    const records = monitoring
      .listRecords(db, siteId, { from, to })
      .filter((record) => !record.blastId);
    const candidates = blasts
      .listBlasts(db, siteId, { state: 'fired' })
      .concat(blasts.listBlasts(db, siteId, { state: 'inspected' }))
      .concat(blasts.listBlasts(db, siteId, { state: 'closed' }))
      .filter((blast) => blast.firedAt);
    return records.map((record) => ({
      recordId: record.id,
      triggeredAt: record.triggeredAt,
      ...matchToBlast(record, candidates, toleranceSeconds),
    }));
  }

  function attach({ recordId, blastId }) {
    return monitoring.attachRecordToBlast(db, recordId, blastId);
  }

  /** Apply every unambiguous suggestion in one go. */
  function attachUnambiguous({ siteId, from, to, toleranceSeconds }) {
    const suggestions = suggestMatches({ siteId, from, to, toleranceSeconds });
    const attached = [];
    for (const suggestion of suggestions) {
      if (suggestion.matched && !suggestion.ambiguous) {
        attach({ recordId: suggestion.recordId, blastId: suggestion.blast.id });
        attached.push({ recordId: suggestion.recordId, blastId: suggestion.blast.id });
      }
    }
    return { attached, considered: suggestions.length, left: suggestions.length - attached.length };
  }

  function receptorsById(siteId) {
    return new Map(monitoring.listReceptors(db, siteId).map((receptor) => [receptor.id, receptor]));
  }

  /** Judge a period against the limits and pull the exceedances out. */
  function assess({ siteId, from, to, thresholds }) {
    const records = monitoring.listRecords(db, siteId, { from, to });
    const { results, unmatched } = evaluateAll(records, receptorsById(siteId), { thresholds });
    return {
      siteId,
      from,
      to,
      recordCount: records.length,
      withoutReceptor: unmatched.length,
      results,
      exceedances: exceedances(results),
      repeats: repeatExceedances(results),
      summary: complianceSummary(results),
    };
  }

  function forBlast({ blastId }) {
    const blast = blasts.getBlast(db, blastId);
    const records = monitoring.listRecords(db, blast.siteId, { blastId });
    const { results } = evaluateAll(records, receptorsById(blast.siteId));
    return {
      blastId,
      reference: blast.reference,
      recordCount: records.length,
      results,
      compliant: results.every((result) => !result.exceedance),
    };
  }

  /**
   * Refit the law from the records that are fit to fit one. `confidence` moves
   * the stored constant onto an upper bound, which is what design work uses.
   */
  function refit({ siteId, receptorId = null, from, to, minimumRecords = 8, confidence = null }) {
    const records = monitoring
      .listRecords(db, siteId, { from, to, receptorId, limit: 2000 })
      .map((record) => ({
        distanceM: record.distanceM,
        chargeKg: chargeFor(record),
        peakMmPerSecond: record.peakMmPerSecond,
        triggerLevelMmPerSecond: null,
        recordId: record.id,
      }));
    const usable = usableForFit(records.filter((record) => record.chargeKg > 0));
    if (usable.length < minimumRecords) {
      throw new ValidationError('there are not enough usable records to refit', [
        {
          path: 'records',
          message: `${usable.length} usable, ${minimumRecords} needed`,
          kind: 'insufficient',
        },
      ]);
    }
    const fit = fitSiteLaw(usable, { minimumRecords });
    const stored = confidence ? upperBound(fit, confidence) : fit;
    const saved = monitoring.saveSiteLaw(
      db,
      {
        siteId,
        receptorId,
        k: stored.k,
        b: stored.b,
        scaling: stored.scaling,
        recordCount: stored.recordCount,
        rSquared: stored.rSquared,
        residualStandardError: stored.residualStandardError,
      },
      context,
    );
    logger?.info?.({ siteId, receptorId, k: stored.k, b: stored.b }, 'site law refitted');
    return { fit, stored: saved, confidence, usableRecords: usable.length };
  }

  function chargeFor(record) {
    if (record.chargeKg) {
      return record.chargeKg;
    }
    if (!record.blastId) {
      return 0;
    }
    const blast = blasts.findBlast(db, record.blastId);
    return blast?.instantaneousChargeKg ?? 0;
  }

  function currentLaw({ siteId, receptorId = null }) {
    const law = monitoring.currentSiteLaw(db, siteId, receptorId);
    if (!law) {
      throw new ConflictError('no site law has been fitted for this site', { siteId });
    }
    return law;
  }

  return { ingest, suggestMatches, attach, attachUnambiguous, assess, forBlast, refit, currentLaw };
}
