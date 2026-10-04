import { useTranslation } from 'react-i18next';

import { formatBytes } from '@/lib/utils';
import type { ArchivePause, AvailabilityReport, HoldReason } from '@/types';

/**
 * Archive's re-acquisition verdict for a title, as a badge plus the reason
 * line. Shared by the queue rows and the item detail page so the wording is
 * the same everywhere.
 */
export function useAvailabilityText() {
  const { t } = useTranslation('common');

  const verdictLabel = (report: AvailabilityReport | undefined | null): string => {
    if (!report) return t('availability.unchecked', 'Not checked yet');
    switch (report.verdict) {
      case 'replaceable':
        return t('availability.replaceable', 'Replaceable');
      case 'at_risk':
        return t('availability.atRisk', 'At risk');
      default:
        return t('availability.unknown', 'Unknown');
    }
  };

  const reasonLine = (report: AvailabilityReport | undefined | null): string => {
    if (!report) return t('availability.uncheckedHint', 'Archive has not asked Radarr/Sonarr about this title yet.');
    const parts: string[] = [];
    for (const reason of report.reasons) {
      switch (reason) {
        case 'no_releases':
          parts.push(
            report.indexers
              ? t('availability.reasons.noReleases', 'No release on any of {{count}} indexers', { count: report.indexers.total })
              : t('availability.reasons.noReleasesPlain', 'No release on any indexer')
          );
          break;
        case 'downgrade':
          parts.push(
            t('availability.reasons.downgrade', 'Best on offer is {{best}}p, your file is {{current}}p', {
              best: report.best?.resolution ?? '?',
              current: report.current?.resolution ?? '?',
            })
          );
          break;
        case 'smaller':
          parts.push(t('availability.reasons.smaller', 'Every release is under half the size of your file'));
          break;
        case 'low_seeders':
          parts.push(t('availability.reasons.lowSeeders', 'Torrents only, best has {{count}} seeders', { count: report.maxSeeders ?? 0 }));
          break;
        case 'missing_seasons':
          parts.push(
            t('availability.reasons.missingSeasons', '{{missing}} of {{checked}} seasons checked have no pack', {
              missing: report.seasons ? report.seasons.checked - report.seasons.withReleases : '?',
              checked: report.seasons?.checked ?? '?',
            })
          );
          break;
        case 'not_linked':
          parts.push(t('availability.reasons.notLinked', 'Not linked to Radarr or Sonarr'));
          break;
        case 'indexers_down':
          parts.push(t('availability.reasons.indexersDown', 'Every indexer is failing right now'));
          break;
        case 'no_indexers':
          parts.push(t('availability.reasons.noIndexers', 'No enabled indexer in Radarr/Sonarr'));
          break;
        case 'no_service':
          parts.push(t('availability.reasons.noService', 'Radarr or Sonarr is not configured'));
          break;
        case 'search_failed':
          parts.push(report.error ? t('availability.reasons.searchFailedWith', 'Search failed: {{error}}', { error: report.error }) : t('availability.reasons.searchFailed', 'Search failed'));
          break;
      }
    }
    if (parts.length > 0) return parts.join(' · ');
    if (report.verdict === 'replaceable') {
      return report.best
        ? t('availability.replaceableDetail', '{{count}} releases available, best {{quality}} ({{size}}) on {{indexer}}', {
            count: report.releases,
            quality: report.best.qualityName,
            size: formatBytes(report.best.sizeBytes),
            indexer: report.best.indexer,
          })
        : t('availability.replaceablePlain', '{{count}} releases available', { count: report.releases });
    }
    return '';
  };

  const holdLabel = (reason: HoldReason | undefined): string => {
    switch (reason) {
      case 'at_risk':
        return t('availability.hold.atRisk', 'Held: may not be downloadable again');
      case 'unknown':
        return t('availability.hold.unknown', 'Held: could not check availability');
      default:
        return t('availability.hold.unchecked', 'Held: availability not checked yet');
    }
  };

  const pauseLine = (pause: ArchivePause): string => {
    const app = pause.service === 'radarr' ? 'Radarr' : 'Sonarr';
    switch (pause.reason) {
      case 'indexers_down':
        return t('availability.pause.indexersDown', '{{app}}: every enabled indexer is failing ({{detail}})', { app, detail: pause.detail });
      case 'rate_limited':
        return t('availability.pause.rateLimited', '{{app}} is rate-limiting searches ({{detail}})', { app, detail: pause.detail });
      case 'unreachable':
        return t('availability.pause.unreachable', '{{app}} could not be reached ({{detail}})', { app, detail: pause.detail });
      default:
        return t('availability.pause.searchFailed', "{{app}}'s release search failed ({{detail}})", { app, detail: pause.detail });
    }
  };

  return { verdictLabel, reasonLine, holdLabel, pauseLine };
}
