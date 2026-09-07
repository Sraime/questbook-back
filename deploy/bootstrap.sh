#!/usr/bin/env bash
#
# Clones the repository into /opt/questbook and writes a .env whose secrets are
# generated on the VPS itself, so they never travel through a laptop shell or a
# terminal history.
#
# Safe to re-run: an existing .env is left alone.
#
#   ssh -p 2222 debian@<vps> \
#     'API_DOMAIN=questbook.example.com GOOGLE_CLIENT_IDS=xxx.apps.googleusercontent.com bash -s' \
#     < deploy/bootstrap.sh

set -euo pipefail

APP_DIR=/opt/questbook
REPO=https://github.com/Sraime/questbook-back.git
BRANCH=main

: "${API_DOMAIN:?set API_DOMAIN, e.g. questbook.example.com}"
: "${GOOGLE_CLIENT_IDS:?set GOOGLE_CLIENT_IDS, the comma-separated OAuth client ids}"

if [[ -d "${APP_DIR}/.git" ]]; then
  echo "==> Repository already cloned, fetching ${BRANCH}"
  git -C "${APP_DIR}" fetch --quiet origin "${BRANCH}"
  git -C "${APP_DIR}" checkout --quiet "${BRANCH}"
  git -C "${APP_DIR}" reset --hard --quiet "origin/${BRANCH}"
else
  echo "==> Cloning ${REPO}"
  git clone --quiet --branch "${BRANCH}" "${REPO}" "${APP_DIR}"
fi

cd "${APP_DIR}"

if [[ -f .env ]]; then
  echo "==> .env already exists, leaving it untouched."
  echo "    Regenerating it is destructive: a new JWT_SECRET signs every user"
  echo "    out, and a new POSTGRES_PASSWORD locks the API out of the existing"
  echo "    database volume. Edit the file by hand instead."
  exit 0
fi

echo "==> Writing .env"
db_password="$(openssl rand -hex 24)"
jwt_secret="$(openssl rand -base64 48)"

umask 077
cat > .env <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
LOG_LEVEL=info

# 'db' is the compose service name: PostgreSQL is never published to the host.
DATABASE_URL=postgresql://questbook:${db_password}@db:5432/questbook?schema=public
POSTGRES_USER=questbook
POSTGRES_PASSWORD=${db_password}
POSTGRES_DB=questbook

JWT_SECRET=${jwt_secret}
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30

GOOGLE_CLIENT_IDS=${GOOGLE_CLIENT_IDS}

CORS_ORIGINS=
RATE_LIMIT_MAX=300
RATE_LIMIT_WINDOW=1 minute

# Invitation links are opened from a mail client, so they must carry the
# public origin rather than the container's own host and port.
PUBLIC_BASE_URL=https://${API_DOMAIN}
INVITATION_TTL_DAYS=14

# Filled in by hand once the Resend domain is verified. Until then invitation
# emails are only logged, and the in-app invitation still works.
RESEND_API_KEY=${RESEND_API_KEY:-}
# Sending from the API's own hostname keeps the From domain identical to the
# domain of the invitation link inside the message, which spam filters reward.
EMAIL_FROM=${EMAIL_FROM:-Questbook <invitations@${API_DOMAIN}>}

# Filled in by hand from a Firebase service account key. Until then push is
# skipped, and the in-app notification history is unaffected.
FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-}
FIREBASE_CLIENT_EMAIL=${FIREBASE_CLIENT_EMAIL:-}
FIREBASE_PRIVATE_KEY=${FIREBASE_PRIVATE_KEY:-}

API_DOMAIN=${API_DOMAIN}
EOF

echo "    .env written with mode $(stat -c '%a' .env); secrets generated here."
echo
echo "Next: ./deploy/deploy.sh"
