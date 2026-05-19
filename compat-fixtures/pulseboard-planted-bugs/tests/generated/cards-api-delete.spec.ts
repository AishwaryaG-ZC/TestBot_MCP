import { test, expect } from './__healix-fixture';

test.describe('GET /api/cards status filter contract', () => {
  // [REQ:F1.S1.AC1] Source declares equality filter on status; implementation filters by priority instead.
  test('[REQ:F1.S1.AC1] GET /api/cards?status=open returns only cards whose status is open @api', async ({ request }) => {
    const response = await request.get('/api/cards?status=open');
    expect(response.status()).toBe(200);
    const cards = await response.json();
    expect(Array.isArray(cards)).toBe(true);
    // At least one open card must exist (source seeds c1 and c3 as open)
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      // Every returned card must carry status === 'open'; priority-based filtering is wrong
      expect(card.status).toBe('open');
    }
  });

  // [REQ:F1.S1.AC4] With an invalid status enum value that coincides with a valid priority name,
  // the buggy handler returns cards matched on priority instead of returning an empty set or 400.
  test('[REQ:F1.S1.AC4] GET /api/cards?status=high returns no cards or a validation error @api', async ({ request }) => {
    // 'high' is a valid priority value but not a valid status enum ('open' | 'done')
    const response = await request.get('/api/cards?status=high');
    if (response.status() === 400) {
      // A 400 is acceptable: server correctly rejected the invalid enum
      return;
    }
    expect(response.status()).toBe(200);
    const cards = await response.json();
    // No card in the fixture has status === 'high'; the array must be empty
    // Bug: returns cards where priority === 'high' (e.g. card c1)
    for (const card of cards) {
      expect(card.status).toBe('high');
    }
    expect(cards).toHaveLength(0);
  });
});

test.describe('DELETE /api/cards/:id response contract', () => {
  // [REQ:F1.S1.AC3] Source returns 200 with an empty body; conventional REST DELETE uses 204.
  // This test documents the advisory: 204 is expected; 200-with-no-body is the planted deviation.
  test('[REQ:F1.S1.AC3] DELETE /api/cards/:id responds 204 (no-content) @api', async ({ request }) => {
    // Fetch a real card id from the list endpoint rather than hardcoding
    const listResponse = await request.get('/api/cards');
    expect(listResponse.status()).toBe(200);
    const cards = await listResponse.json();
    expect(cards.length).toBeGreaterThan(0);
    const cardId = cards[0].id;

    const response = await request.delete(`/api/cards/${cardId}`);
    // PRD advisory: source code issues 200 with an empty body; expected contract is 204
    expect(response.status()).toBe(204);
  });
});

test.describe('Board form accessible validation', () => {
  // [REQ:F1.S1.AC2] The form carries HTML required attributes but no programmatic inline validation;
  // submitting without values should surface an accessible error region (role=alert or aria-live).
  test('[REQ:F1.S1.AC2] submitting the board form with empty fields shows accessible inline validation', async ({ page }) => {
    await page.goto('/');

    // Attempt to submit without filling required fields
    await page.getByRole('button', { name: 'Create card' }).click();

    // Accessible inline validation must be present in the DOM
    // (role="alert" or an aria-live region surfacing the field errors)
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
  });
});
