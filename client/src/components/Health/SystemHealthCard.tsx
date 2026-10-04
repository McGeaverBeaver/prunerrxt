import { Activity, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CONNECTIONS_SETTINGS_PATH, serviceHomeUrl } from '@/lib/links';
import { useMediaServerName, useSettings } from '@/hooks/useApi';
import { ServiceStatusIndicator } from './ServiceStatusIndicator';
import type { ServiceHealthStatus } from '@/types';

/** Health rows that are one of the watch history providers, of which only one is in use. */
const WATCH_HISTORY_PROVIDERS = new Set(['tautulli', 'tracearr']);

interface SystemHealthCardProps {
  services: ServiceHealthStatus[];
  overall: 'healthy' | 'degraded' | 'unhealthy';
  loading?: boolean;
  isFetching?: boolean;
}

export function SystemHealthCard({ services, overall, loading, isFetching }: SystemHealthCardProps) {
  const { t } = useTranslation('health');
  // Service URLs so each row links to the service it reports on.
  const { data: settings } = useSettings();
  // Health reports the media server under its historical 'plex' key whatever
  // backend is in use, so label that row with the configured server's name.
  const mediaServer = useMediaServerName();
  const displayName = (service: string) => (service === 'plex' ? mediaServer : service);
  const overallConfig = {
    healthy: {
      color: 'text-emerald-text',
      bgColor: 'bg-emerald-500/10',
      label: t('overall.healthy', 'All Systems Operational'),
    },
    degraded: {
      color: 'text-accent-text',
      bgColor: 'bg-amber-500/10',
      label: t('overall.degraded', 'Partial Outage'),
    },
    unhealthy: {
      color: 'text-ruby-text',
      bgColor: 'bg-ruby-500/10',
      label: t('overall.unhealthy', 'Systems Unavailable'),
    },
  };

  const config = overallConfig[overall];

  // Tautulli and Tracearr are alternatives, not a checklist: only the chosen
  // watch history provider is a setup step, so a provider that is neither
  // selected nor configured is left off the list instead of reading as
  // "Not configured". Legacy installs never stored the choice; for them,
  // whatever is configured is what counts.
  const watchProvider = settings?.watchHistory?.provider;
  const visibleServices = services.filter(
    (s) => !WATCH_HISTORY_PROVIDERS.has(s.service) || s.configured || watchProvider === s.service
  );

  // Sort services: configured first, then alphabetically
  const sortedServices = [...visibleServices].sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return displayName(a.service).localeCompare(displayName(b.service));
  });

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={cn('p-1.5 rounded-lg', config.bgColor)}>
            {overall === 'unhealthy' ? (
              <AlertCircle className={cn('w-4 h-4', config.color)} />
            ) : (
              <Activity className={cn('w-4 h-4', config.color)} />
            )}
          </div>
          <div>
            <h3 className="text-sm font-medium text-surface-50">{t('header.title', 'Service Status')}</h3>
            <p className={cn('text-xs', config.color)}>{config.label}</p>
          </div>
        </div>
        {isFetching && !loading && (
          <span className="text-xs text-surface-500 animate-pulse">{t('header.refreshing', 'Refreshing...')}</span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="skeleton-shimmer h-6 rounded" />
          ))}
        </div>
      ) : (
        <div className="space-y-0.5">
          {sortedServices.map((service) => (
            <ServiceStatusIndicator
              key={service.service}
              name={displayName(service.service)}
              configured={service.configured}
              connected={service.connected}
              error={service.error}
              responseTimeMs={service.responseTimeMs}
              loading={isFetching}
              href={serviceHomeUrl(settings, service.service)}
              settingsHref={CONNECTIONS_SETTINGS_PATH}
            />
          ))}
        </div>
      )}
    </div>
  );
}
