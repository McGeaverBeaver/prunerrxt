import { useTranslation } from 'react-i18next';
import { Archive, CircleHelp, ShieldAlert, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/common/Badge';
import { useAvailabilityText } from '@/lib/availabilityText';
import type { AvailabilityReport } from '@/types';

/** Archive's re-acquisition verdict for a title as a badge; the reason line comes from useAvailabilityText. */

export function AvailabilityBadge({ report, archived = false, className }: { report: AvailabilityReport | null | undefined; archived?: boolean; className?: string }) {
  const { verdictLabel } = useAvailabilityText();
  const { t } = useTranslation('common');
  if (archived) {
    return (
      <Badge variant="accent" className={className}>
        <Archive className="w-3 h-3" />
        {t('availability.archived', 'Archived')}
      </Badge>
    );
  }
  if (!report) {
    return (
      <Badge variant="muted" className={className}>
        <CircleHelp className="w-3 h-3" />
        {verdictLabel(report)}
      </Badge>
    );
  }
  if (report.verdict === 'replaceable') {
    return (
      <Badge variant="success" className={className}>
        <ShieldCheck className="w-3 h-3" />
        {verdictLabel(report)}
      </Badge>
    );
  }
  if (report.verdict === 'at_risk') {
    return (
      <Badge variant="warning" className={className}>
        <ShieldAlert className="w-3 h-3" />
        {verdictLabel(report)}
      </Badge>
    );
  }
  return (
    <Badge variant="muted" className={className}>
      <CircleHelp className="w-3 h-3" />
      {verdictLabel(report)}
    </Badge>
  );
}
