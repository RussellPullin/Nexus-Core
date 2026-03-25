#!/bin/bash
# Test the Azure Function directly (bypasses the Schedule Shift server).
# Usage: ./test-send.sh <FUNCTION_URL> <FROM_EMAIL> <TO_EMAIL> [API_KEY]
# Example: ./test-send.sh http://localhost:7071/api/sendEmail you@company.com staff@example.com sohva9-jibvuz-sicTux

URL="${1:?Usage: $0 <FUNCTION_URL> <FROM_EMAIL> <TO_EMAIL> [API_KEY]}"
FROM="${2:?}"
TO="${3:?}"
API_KEY="${4:-}"

BODY=$(cat <<EOF
{
  "to": "$TO",
  "subject": "Schedule Shift – Direct test",
  "text": "This is a direct test of the Azure Function. If you receive this, the function and Graph API are working.",
  "from": "$FROM",
  "attachments": []
}
EOF
)

HEADERS=(-H "Content-Type: application/json")
[ -n "$API_KEY" ] && HEADERS+=(-H "x-api-key: $API_KEY")

echo "POST $URL"
echo "From: $FROM  To: $TO"
echo "---"
curl -s -w "\nHTTP %{http_code}\n" -X POST "${HEADERS[@]}" -d "$BODY" "$URL"
echo ""
echo "If you get HTTP 200 but no email, check: spam folder, 'from' must be an M365 mailbox in your tenant."
