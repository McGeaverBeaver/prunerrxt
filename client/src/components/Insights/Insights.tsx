import { useTranslation } from 'react-i18next';

import { StackHealthBlock } from './StackHealthBlock';
import { LibraryQualityBlock } from './LibraryQualityBlock';
import { WatchPatternsBlock } from './WatchPatternsBlock';
import { PlaybackFrictionBlock } from './PlaybackFrictionBlock';
import { TrendStrip } from './TrendStrip';

/**
 * Insights: how the whole setup is doing, in four blocks. Stack health
 * (what is wrong and where), library quality, watch patterns and playback
 * friction. Each block loads on its own, so an app that is down only
 * affects the block that needs it.
 */
export default function Insights() {
  const { t } = useTranslation('insights');

  return (
    <div className="space-y-6 pb-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-surface-50">{t('title', 'Insights')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-surface-400">
          {t('description', 'How the stack is running, what the library is made of, what people actually watch, and where playback struggles. Read from the services you already connected; nothing leaves this server.')}
        </p>
      </div>

      <TrendStrip />
      <StackHealthBlock />
      <LibraryQualityBlock />
      <WatchPatternsBlock />
      <PlaybackFrictionBlock />
    </div>
  );
}
