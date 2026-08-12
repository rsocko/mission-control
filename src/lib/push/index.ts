import 'server-only';

export {
  dispatchNotificationDeliveries,
  claimNotificationDelivery,
  calculateRetryDelayMs,
} from './dispatcher';

export function getVapidPublicKey(): string {
  return process.env.VAPID_PUBLIC_KEY ?? '';
}
