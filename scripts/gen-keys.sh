#!/usr/bin/env bash
#
# Generate the Ed25519 keypair used to sign access tokens.
#
# Asymmetric (EdDSA) rather than a shared HMAC secret so a future service can
# verify tokens without holding signing material — see ADR 0007.
#
#   ./scripts/gen-keys.sh
#
set -euo pipefail

KEY_DIR="${1:-./keys}"
PRIVATE="$KEY_DIR/jwt-private.pem"
PUBLIC="$KEY_DIR/jwt-public.pem"

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl is required" >&2
  exit 1
fi

mkdir -p "$KEY_DIR"

if [[ -f "$PRIVATE" ]]; then
  echo "refusing to overwrite $PRIVATE"
  echo "every existing session is signed with it; delete it deliberately if you"
  echo "intend to invalidate them all."
  exit 1
fi

openssl genpkey -algorithm ed25519 -out "$PRIVATE"
openssl pkey -in "$PRIVATE" -pubout -out "$PUBLIC"

# The private key must not be world-readable, and ./keys is gitignored.
chmod 600 "$PRIVATE"
chmod 644 "$PUBLIC"

echo "wrote $PRIVATE and $PUBLIC"
echo
echo "For a deployment UI that takes inline values rather than file paths,"
echo "paste these (newlines escaped):"
echo
echo "JWT_PRIVATE_KEY=\"$(awk '{printf "%s\\n", $0}' "$PRIVATE")\""
echo "JWT_PUBLIC_KEY=\"$(awk '{printf "%s\\n", $0}' "$PUBLIC")\""
