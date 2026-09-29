import { describe, it, expect } from 'vitest';

import { mediaServerName } from '../mediaServer';

describe('mediaServerName', () => {
  it('names each supported backend', () => {
    expect(mediaServerName('plex')).toBe('Plex');
    expect(mediaServerName('jellyfin')).toBe('Jellyfin');
    expect(mediaServerName('emby')).toBe('Emby');
  });

  it('falls back to Plex when the type was never stored', () => {
    expect(mediaServerName(undefined)).toBe('Plex');
    expect(mediaServerName(null)).toBe('Plex');
  });
});
