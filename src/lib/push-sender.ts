import type { FastifyBaseLogger } from 'fastify';
import { JWT } from 'google-auth-library';

export interface PushMessage {
  tokens: string[];
  title: string;
  body: string;
  /// FCM only carries string values in the data payload.
  data?: Record<string, string>;
}

export interface PushResult {
  /// Tokens Firebase reported as dead, so the caller can delete them rather
  /// than retrying them forever.
  staleTokens: string[];
}

export interface PushSender {
  send(message: PushMessage): Promise<PushResult>;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/// Talks to FCM HTTP v1 with a service account, using `google-auth-library`
/// (already a dependency for verifying Google ID tokens) to mint the access
/// token. The alternative, `firebase-admin`, would pull in tens of megabytes
/// for the one endpoint this app actually calls.
export function createFcmPushSender(options: {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  logger: FastifyBaseLogger;
}): PushSender {
  const auth = new JWT({
    email: options.clientEmail,
    key: options.privateKey,
    scopes: [FCM_SCOPE],
  });

  const endpoint = `https://fcm.googleapis.com/v1/projects/${options.projectId}/messages:send`;

  return {
    async send(message) {
      if (message.tokens.length === 0) {
        return { staleTokens: [] };
      }

      const { token: accessToken } = await auth.getAccessToken();
      if (!accessToken) {
        throw new Error('Firebase refused to issue an access token');
      }

      const staleTokens: string[] = [];

      // HTTP v1 has no multicast endpoint, so this is one request per device.
      // At this app's scale that is a handful of calls per notification.
      await Promise.all(
        message.tokens.map(async (token) => {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token,
                notification: { title: message.title, body: message.body },
                data: message.data,
                android: { priority: 'high' },
              },
            }),
          });

          if (response.ok) {
            return;
          }

          const body = await response.text();
          // 404 UNREGISTERED means the app was uninstalled; 400 INVALID_ARGUMENT
          // on the token field means it was never valid. Both are permanent.
          if (response.status === 404 || response.status === 400) {
            staleTokens.push(token);
            return;
          }

          options.logger.warn(
            { status: response.status, body },
            'FCM rejected a push message',
          );
        }),
      );

      return { staleTokens };
    },
  };
}

/// Used when no Firebase service account is configured. Notifications are
/// still written to the database, so the in-app history stays complete.
export function createLoggingPushSender(logger: FastifyBaseLogger): PushSender {
  return {
    async send(message) {
      logger.info(
        { deviceCount: message.tokens.length, title: message.title },
        'Push not sent: no Firebase service account configured',
      );
      return { staleTokens: [] };
    },
  };
}
