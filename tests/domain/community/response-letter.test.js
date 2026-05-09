import { describe, it, expect } from 'vitest';
import { buildResponse, renderLetter } from '../../../src/domain/community/response-letter.js';
import { ValidationError } from '../../../src/lib/errors.js';

const site = { id: 'site_1', name: 'Midway Quarry' };
const author = { id: 'per_1', name: 'A Whelan' };

const complaint = {
  id: 'cmp_1',
  receivedAt: '2026-05-13T09:15:00.000Z',
  occurredAt: '2026-05-12T14:02:00.000Z',
  about: 'vibration',
  complainant: 'Mrs Hurley',
  contact: 'telephone',
  description: 'the pictures came off the wall just after two yesterday afternoon',
};

const blast = { reference: 'MDW-2026-020', firedAt: '2026-05-12T14:02:00.000Z' };

describe('buildResponse', () => {
  it('opens by thanking them and repeating what they said', () => {
    const response = buildResponse({ complaint, site, blast, author });
    expect(response.paragraphs[0]).toContain('Thank you for contacting us');
    expect(response.paragraphs[1]).toContain('pictures came off the wall');
  });

  it('names the blast that was fired that day', () => {
    const response = buildResponse({ complaint, site, blast, author });
    expect(response.paragraphs[2]).toContain('MDW-2026-020');
    expect(response.paragraphs[2]).toContain('14:02');
  });

  it('says plainly when nothing was fired', () => {
    const response = buildResponse({ complaint, site, blast: null, author });
    expect(response.paragraphs[2]).toContain('did not fire a blast');
  });

  it('quotes the highest reading and the limit that applied', () => {
    const response = buildResponse({
      complaint,
      site,
      blast,
      author,
      records: [
        { peakMmPerSecond: 3.14159, limitMmPerSecond: 19.1 },
        { peakMmPerSecond: 1.2, limitMmPerSecond: 19.1 },
      ],
    });
    expect(response.paragraphs[3]).toContain('3.14 millimetres per second');
    expect(response.paragraphs[3]).toContain('19.1');
    expect(response.facts.readingsQuoted).toBe(2);
  });

  it('never tells them the house did not shake', () => {
    const letter = renderLetter(
      buildResponse({
        complaint,
        site,
        blast,
        author,
        records: [{ peakMmPerSecond: 2, limitMmPerSecond: 19.1 }],
      }),
    );
    expect(letter.toLowerCase()).not.toContain('mistaken');
    expect(letter.toLowerCase()).not.toContain('could not have');
  });

  it('states an exceedance and what is being done about it', () => {
    const response = buildResponse({
      complaint,
      site,
      blast,
      author,
      records: [{ peakMmPerSecond: 26, limitMmPerSecond: 19.1 }],
    });
    expect(response.facts.overLimit).toBe(true);
    expect(response.paragraphs.some((line) => line.includes('reported it to the regulator'))).toBe(
      true,
    );
  });

  it('offers a monitor when there was no reading', () => {
    const response = buildResponse({ complaint, site, blast, author });
    expect(response.paragraphs.some((line) => line.includes('putting a monitor'))).toBe(true);
  });

  it('shortens a very long complaint rather than dropping it', () => {
    const long = { ...complaint, description: 'x'.repeat(400) };
    const response = buildResponse({ complaint: long, site, blast, author });
    expect(response.paragraphs[1].length).toBeLessThan(230);
    expect(response.paragraphs[1]).toContain('...');
  });

  it('addresses the occupier when nobody gave a name', () => {
    const response = buildResponse({
      complaint: { ...complaint, complainant: null },
      site,
      blast,
      author,
    });
    expect(response.to).toBe('the occupier');
  });

  it('carries the facts the file needs beside the words', () => {
    const response = buildResponse({
      complaint,
      site,
      blast,
      author,
      records: [{ peakMmPerSecond: 4, limitMmPerSecond: 19.1 }],
    });
    expect(response.facts).toMatchObject({
      complaintId: 'cmp_1',
      blastReference: 'MDW-2026-020',
      highestReadingMmPerSecond: 4,
      overLimit: false,
    });
  });

  it('refuses to write one with nobody signing it', () => {
    expect(() => buildResponse({ complaint, site, blast })).toThrow(ValidationError);
  });

  it('uses the right words for each kind of complaint', () => {
    const dust = buildResponse({ complaint: { ...complaint, about: 'dust' }, site, author });
    expect(dust.subject).toContain('dust');
    const flyrock = buildResponse({ complaint: { ...complaint, about: 'flyrock' }, site, author });
    expect(flyrock.subject).toContain('material leaving the site');
  });
});

describe('renderLetter', () => {
  it('writes something that can be pasted into an email', () => {
    const letter = renderLetter(buildResponse({ complaint, site, blast, author }));
    expect(letter.startsWith('To: Mrs Hurley')).toBe(true);
    expect(letter).toContain('Subject: Your report of vibration on 2026-05-12');
    expect(letter.trimEnd().endsWith('A Whelan')).toBe(true);
  });
});
