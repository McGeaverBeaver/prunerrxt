import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import type { ConditionNode } from '@/types';

const previewV2 = vi.fn();
vi.mock('@/services/api', () => ({ rulesApi: { previewV2: (...args: unknown[]) => previewV2(...args) } }));

import { LivePreview } from '../LivePreview';

const ROOT: ConditionNode = {
  kind: 'group',
  logic: 'AND',
  children: [{ kind: 'condition', field: 'play_count', operator: 'equals', value: 0 }],
} as ConditionNode;

/** Fake server: 12 protected + 15 unprotected matches, largest first. */
function fakePreview(body: { sampleOffset?: number; sampleLimit?: number; includeProtectedSamples?: boolean }) {
  const all = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `Protected ${i + 1}`, size: 2e9 - i, isProtected: true })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: 100 + i, title: `Free ${i + 1}`, size: 1e9 - i, isProtected: false })),
  ].map((s) => ({ ...s, rating: null }));
  const list = body.includeProtectedSamples === false ? all.filter((s) => !s.isProtected) : all;
  const offset = body.sampleOffset ?? 0;
  return Promise.resolve({
    totalMatches: 27,
    wouldQueue: 15,
    wouldSkipProtected: 12,
    storageFreedGB: 1,
    samples: list.slice(offset, offset + (body.sampleLimit ?? 10)),
    sampleTotal: list.length,
  });
}

function renderPreview() {
  return render(
    <MemoryRouter>
      <LivePreview root={ROOT} />
    </MemoryRouter>
  );
}

describe('LivePreview matches list', () => {
  beforeEach(() => {
    localStorage.clear();
    previewV2.mockReset();
    previewV2.mockImplementation(fakePreview);
  });

  it('hides protected items by default and pages through the rest', async () => {
    renderPreview();

    expect(await screen.findByText('Free 1')).toBeInTheDocument();
    expect(screen.queryByText('Protected 1')).not.toBeInTheDocument();
    expect(previewV2).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeProtectedSamples: false, sampleOffset: 0, sampleLimit: 10 })
    );
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('1–10 of 15')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Free 11')).toBeInTheDocument();
    expect(screen.getByText('11–15 of 15')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('shows protected items with a shield once toggled, and remembers it', async () => {
    renderPreview();
    await screen.findByText('Free 1');

    fireEvent.click(screen.getByRole('switch'));

    expect(await screen.findByText('Protected 1')).toBeInTheDocument();
    expect(screen.getByText('1–10 of 27')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Protected').length).toBeGreaterThan(0);
    expect(localStorage.getItem('rules-preview-show-protected')).toBe('true');
  });

  it('goes back to the first page when protected items are toggled', async () => {
    renderPreview();
    await screen.findByText('Free 1');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Free 11');

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() =>
      expect(previewV2).toHaveBeenLastCalledWith(
        expect.objectContaining({ includeProtectedSamples: true, sampleOffset: 0 })
      )
    );
    expect(await screen.findByText('Protected 1')).toBeInTheDocument();
  });
});
