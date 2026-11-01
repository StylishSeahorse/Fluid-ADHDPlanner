/**
 * Node-only startup, imported only from the Node branch of
 * `instrumentation.ts`: the push-notification dispatcher and the background
 * job worker (calendar sync, push-channel renewal).
 */
import { features } from '@fluid/env';
import { startNotificationLoop } from './server/services/notifications';
import { startCalendarWorker } from './server/jobs/calendar-jobs';
import { startReplanWorker } from './server/jobs/replan-jobs';

if (features.notifications) startNotificationLoop();
if (features.worker) {
  void startCalendarWorker();
  void startReplanWorker();
}
