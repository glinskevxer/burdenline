/**
 * The letter that goes back to somebody who complained.
 *
 * It has a shape because the same letter has to be defensible a year later at a
 * planning review: what they said, what was fired that day, what the monitors
 * recorded, what the limit was, and what is being done. Writing it by hand every
 * time produces letters that quietly leave out whichever of those is awkward.
 *
 * The tone is deliberately plain and it never argues. A reading under the limit
 * is stated as a reading under the limit, not as evidence that the complaint was
 * mistaken, because the house did shake and telling somebody it did not is how a
 * complaint becomes a planning objection.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';

export function buildResponse({
  complaint,
  site,
  blast = null,
  records = [],
  limitMmPerSecond = null,
  author,
  sentOn,
}) {
  if (!complaint || !site || !author) {
    throw new ValidationError('a response needs the complaint, the site and who is signing it', [
      { path: 'author', message: 'missing', kind: 'missing' },
    ]);
  }
  const measured = records
    .filter((record) => typeof record.peakMmPerSecond === 'number')
    .sort((a, b) => b.peakMmPerSecond - a.peakMmPerSecond);
  const highest = measured[0] ?? null;
  const limit = limitMmPerSecond ?? highest?.limitMmPerSecond ?? null;

  const paragraphs = [];
  paragraphs.push(
    `Thank you for contacting us on ${complaint.receivedAt.slice(0, 10)} about ${subjectWords(complaint.about)} from ${site.name}.`,
  );
  paragraphs.push(
    complaint.description.length > 200
      ? `You told us: ${complaint.description.slice(0, 197)}...`
      : `You told us: ${complaint.description}`,
  );

  if (blast) {
    paragraphs.push(
      `We fired one blast that day, reference ${blast.reference}, at ${blast.firedAt?.slice(11, 16) ?? 'a time we have recorded'}.`,
    );
  } else {
    paragraphs.push('We did not fire a blast at the time you have described.');
  }

  if (highest) {
    const reading = `${roundTo(highest.peakMmPerSecond, 2)} millimetres per second`;
    paragraphs.push(
      limit
        ? `The monitor nearest you recorded ${reading}. The limit that applies there is ${roundTo(limit, 2)} millimetres per second.`
        : `The monitor nearest you recorded ${reading}.`,
    );
    if (limit && highest.peakMmPerSecond > limit) {
      paragraphs.push(
        'That reading is above the limit. We have reported it to the regulator and the design of the next blast is being reviewed before anything else is fired.',
      );
    }
  } else if (blast) {
    paragraphs.push('We have no monitor reading for your property for that blast.');
  }

  paragraphs.push(nextStep(complaint, highest, limit));
  paragraphs.push(
    `If you would like to talk this through, or if it happens again, please contact ${author.name} at ${site.name}.`,
  );

  return {
    to: complaint.complainant ?? 'the occupier',
    contact: complaint.contact ?? null,
    subject: `Your report of ${subjectWords(complaint.about)} on ${(complaint.occurredAt ?? complaint.receivedAt).slice(0, 10)}`,
    sentOn: sentOn ?? null,
    signedBy: author.name,
    paragraphs,
    facts: {
      complaintId: complaint.id ?? null,
      blastReference: blast?.reference ?? null,
      highestReadingMmPerSecond: highest ? roundTo(highest.peakMmPerSecond, 2) : null,
      limitMmPerSecond: limit ? roundTo(limit, 2) : null,
      overLimit: Boolean(highest && limit && highest.peakMmPerSecond > limit),
      readingsQuoted: measured.length,
    },
  };
}

function nextStep(complaint, highest, limit) {
  if (highest && limit && highest.peakMmPerSecond > limit) {
    return 'We will write to you again when the review of the design is finished.';
  }
  if (!highest) {
    return 'We are putting a monitor at your property for the next blast so that we have a reading of our own.';
  }
  return 'We keep the readings for every blast and you are welcome to see them at any time.';
}

function subjectWords(about) {
  return (
    {
      vibration: 'vibration',
      airblast: 'noise and air pressure',
      dust: 'dust',
      noise: 'noise',
      flyrock: 'material leaving the site',
      traffic: 'traffic',
      other: 'a disturbance',
    }[about] ?? 'a disturbance'
  );
}

/** The letter as plain text, which is what gets pasted into an email. */
export function renderLetter(response) {
  return [
    `To: ${response.to}`,
    `Subject: ${response.subject}`,
    '',
    ...response.paragraphs,
    '',
    response.signedBy,
  ].join('\n');
}
