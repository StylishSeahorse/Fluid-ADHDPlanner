/**
 * Node-only startup: the push-notification dispatcher. Imported only from the
 * Node branch of `instrumentation.ts`.
 */
import { features } from '@fluid/env';
import { startNotificationLoop } from './server/services/notifications';

if (features.notifications) startNotificationLoop();
