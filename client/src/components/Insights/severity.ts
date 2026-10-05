import { useTranslation } from 'react-i18next';
import { AlertOctagon, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

import type { InsightSeverity, InsightSource } from '@/types';

export const SEVERITY_STYLE: Record<InsightSeverity, { dot: string; text: string; ring: string; Icon: typeof Info }> = {
  critical: { dot: 'bg-ruby-500', text: 'text-ruby-text', ring: 'border-ruby-500/25 bg-ruby-500/[0.06]', Icon: AlertOctagon },
  warning: { dot: 'bg-amber-500', text: 'text-accent-text', ring: 'border-amber-500/25 bg-amber-500/[0.06]', Icon: AlertTriangle },
  info: { dot: 'bg-sky-500', text: 'text-surface-300', ring: 'border-surface-700/60 bg-surface-800/40', Icon: Info },
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-text', ring: 'border-emerald-500/25 bg-emerald-500/[0.06]', Icon: CheckCircle2 },
};

export function useSeverityLabel() {
  const { t } = useTranslation('insights');
  return (severity: InsightSeverity): string => {
    switch (severity) {
      case 'critical':
        return t('severity.critical', 'Critical');
      case 'warning':
        return t('severity.warning', 'Warning');
      case 'info':
        return t('severity.info', 'Info');
      case 'ok':
        return t('severity.ok', 'OK');
    }
  };
}

export function useSourceLabel() {
  const { t } = useTranslation('insights');
  return (source: InsightSource, mediaServer: string): string => {
    switch (source) {
      case 'prunerr':
        return 'PrunerrXT';
      case 'mediaServer':
        return mediaServer;
      case 'sonarr':
        return 'Sonarr';
      case 'radarr':
        return 'Radarr';
      case 'tautulli':
        return 'Tautulli';
      case 'tracearr':
        return 'Tracearr';
      case 'overseerr':
        return t('source.overseerr', 'Seerr');
      case 'unraid':
        return 'Unraid';
    }
  };
}

