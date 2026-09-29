import type { MediaServerType } from '@/types';

/** Display names for the supported media server backends. */
export const MEDIA_SERVER_NAMES: Record<MediaServerType, string> = {
  plex: 'Plex',
  jellyfin: 'Jellyfin',
  emby: 'Emby',
};

/**
 * Display name for the configured media server. Settings leave the type unset
 * on installs that predate Jellyfin/Emby support, which were all Plex.
 */
export function mediaServerName(type: MediaServerType | null | undefined): string {
  return MEDIA_SERVER_NAMES[type ?? 'plex'] ?? MEDIA_SERVER_NAMES.plex;
}
