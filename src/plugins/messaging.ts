import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  createLoggingEmailSender,
  createResendEmailSender,
  type EmailSender,
} from '../lib/email-sender.js';
import {
  createFcmPushSender,
  createLoggingPushSender,
  type PushSender,
} from '../lib/push-sender.js';
import { NotificationService } from '../modules/notifications/notification.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    email: EmailSender;
    notifications: NotificationService;
  }
}

export interface MessagingPluginOptions {
  resendApiKey: string;
  emailFrom: string;
  firebaseProjectId: string;
  firebaseClientEmail: string;
  firebasePrivateKey: string;
  /// Test seams, mirroring how the auth plugin accepts a stubbed verifier.
  emailSender?: EmailSender;
  pushSender?: PushSender;
}

async function messagingPlugin(
  app: FastifyInstance,
  options: MessagingPluginOptions,
): Promise<void> {
  const email =
    options.emailSender ??
    (options.resendApiKey
      ? createResendEmailSender({
          apiKey: options.resendApiKey,
          from: options.emailFrom,
          logger: app.log,
        })
      : createLoggingEmailSender(app.log));

  const hasFirebaseCredentials =
    options.firebaseProjectId && options.firebaseClientEmail && options.firebasePrivateKey;

  const push =
    options.pushSender ??
    (hasFirebaseCredentials
      ? createFcmPushSender({
          projectId: options.firebaseProjectId,
          clientEmail: options.firebaseClientEmail,
          privateKey: options.firebasePrivateKey,
          logger: app.log,
        })
      : createLoggingPushSender(app.log));

  app.decorate('email', email);
  app.decorate('notifications', new NotificationService(app.prisma, push, app.log));
}

export default fp(messagingPlugin, { name: 'messaging', dependencies: ['prisma'] });
