import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { standUp } from './helpers.js';

let harness;
let siteId;

const at = '2025-12-22T09:00:00.000Z';

async function post(url, role, payload) {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: harness.as(role),
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function get(url, role) {
  return harness.app.inject({ method: 'GET', url, headers: harness.as(role) });
}

const complaint = {
  channel: 'telephone',
  about: 'vibration',
  description: 'the pictures came off the wall again just after two yesterday',
  complainant: 'Mrs Hurley',
};

beforeEach(async () => {
  harness = await standUp({ at });
  siteId = (await post('/sites', 'admin', { code: 'MDW', name: 'Midway' })).json().site.id;
});

afterEach(async () => {
  await harness.close();
});

describe('recording one', () => {
  it('takes the minimum a person can get down on the telephone', async () => {
    const response = await post(`/sites/${siteId}/complaints`, 'viewer', complaint);
    expect(response.statusCode).toBe(201);
    expect(response.json().complaint.state).toBe('open');
    expect(response.json().complaint.receptorId).toBe(null);
  });

  it('stamps the time it was taken when none is given', async () => {
    const response = await post(`/sites/${siteId}/complaints`, 'viewer', complaint);
    expect(response.json().complaint.receivedAt).toBe(at);
  });

  it('records who took it', async () => {
    const response = await post(`/sites/${siteId}/complaints`, 'viewer', complaint);
    expect(response.json().complaint.receivedBy).toBe('per_viewer');
  });

  it('refuses a subject that is not one of the listed ones', async () => {
    const response = await post(`/sites/${siteId}/complaints`, 'viewer', {
      ...complaint,
      about: 'the weather',
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses one against a site that is not there', async () => {
    expect((await post('/sites/site_missing/complaints', 'viewer', complaint)).statusCode).toBe(
      404,
    );
  });
});

describe('the register', () => {
  it('lists them with a summary of what is overdue', async () => {
    await post(`/sites/${siteId}/complaints`, 'viewer', complaint);
    const response = await get(`/sites/${siteId}/complaints`, 'viewer');
    expect(response.json().complaints).toHaveLength(1);
    expect(response.json().summary.openCount).toBe(1);
  });

  it('filters by state', async () => {
    const id = (await post(`/sites/${siteId}/complaints`, 'viewer', complaint)).json().complaint.id;
    await post(`/complaints/${id}/respond`, 'manager', { outcome: 'answered by letter' });
    expect(
      (await get(`/sites/${siteId}/complaints?state=open`, 'viewer')).json().complaints,
    ).toHaveLength(0);
    expect(
      (await get(`/sites/${siteId}/complaints?state=responded`, 'viewer')).json().complaints,
    ).toHaveLength(1);
  });

  it('reads one back with its clock and what it might be about', async () => {
    const id = (await post(`/sites/${siteId}/complaints`, 'viewer', complaint)).json().complaint.id;
    const response = await get(`/complaints/${id}`, 'viewer');
    expect(response.json().clock.hoursOpen).toBe(0);
    expect(response.json().match.matched).toBe(false);
    expect(response.json().supporting).toEqual([]);
  });

  it('answers 404 for one that is not there', async () => {
    expect((await get('/complaints/rep_missing', 'viewer')).statusCode).toBe(404);
  });
});

describe('working one through', () => {
  async function open() {
    return (await post(`/sites/${siteId}/complaints`, 'viewer', complaint)).json().complaint.id;
  }

  it('moves through investigation to a reply and a close', async () => {
    const id = await open();
    expect((await post(`/complaints/${id}/investigate`, 'manager')).json().complaint.state).toBe(
      'investigating',
    );
    const responded = await post(`/complaints/${id}/respond`, 'manager', {
      outcome: 'the readings were well under the limit',
    });
    expect(responded.json().complaint.state).toBe('responded');
    expect((await post(`/complaints/${id}/close`, 'manager')).json().complaint.state).toBe(
      'closed',
    );
  });

  it('refuses a move that is not allowed from here', async () => {
    const id = await open();
    expect((await post(`/complaints/${id}/close`, 'manager')).statusCode).toBe(409);
  });

  it('refuses to reply with nothing written down', async () => {
    const id = await open();
    expect((await post(`/complaints/${id}/respond`, 'manager', {})).statusCode).toBe(422);
  });

  it('takes a plain button press for the moves that say nothing', async () => {
    const id = await open();
    expect((await post(`/complaints/${id}/investigate`, 'manager')).statusCode).toBe(200);
  });

  it('ties one to a shot', async () => {
    const id = await open();
    const blastId = (
      await post(`/sites/${siteId}/blasts`, 'designer', { reference: 'MDW-2025-014' })
    ).json().blast.id;
    const response = await post(`/complaints/${id}/blast`, 'manager', { blastId });
    expect(response.json().complaint.blastId).toBe(blastId);
  });

  it('refuses to tie one to a shot that is not there', async () => {
    const id = await open();
    expect(
      (await post(`/complaints/${id}/blast`, 'manager', { blastId: 'blast_x' })).statusCode,
    ).toBe(404);
  });
});
