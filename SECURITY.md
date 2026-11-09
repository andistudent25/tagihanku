# Security notes for TagihanKu

TagihanKu is an academic demonstration. It is not a production financial service.

## Public frontend configuration

`backend-config.js` contains the public Google Apps Script Web App URL. This URL is an endpoint identifier, not an authentication secret. It must be public for a static browser frontend to call the API. Never place spreadsheet IDs, Script Properties values, password hashes, session tokens, personal records, or API credentials in frontend files or Git history.

## Backend limitations

- The Apps Script Web App is accessible anonymously and executes as its owner. The server must authenticate every private operation with a session token and scope records to the authenticated user.
- Public registration may be abused and can consume the owner's Apps Script/Sheets quotas. Monitor usage and close registration when it is no longer needed for the assignment.
- The included PBKDF2-HMAC-SHA256 iteration count is a demonstration baseline below current password-storage recommendations. Do not use real or reused passwords. Use a managed identity provider and professionally reviewed password hashing for production.
- Email ownership is not verified. Payment actions only write simulated transactions; they do not move money.
- Google Sheets and Apps Script are not intended here as a high-volume transactional database.

## Before publishing

1. Keep the Google spreadsheet private. Do not share it publicly or commit its ID.
2. Keep Script Properties secrets inside Apps Script. Do not export them to the repository.
3. Do not commit real user records, passwords, tokens, bank details, OTPs, or payment credentials.
4. Use only test accounts and synthetic bill data for the assignment.
5. If a secret is ever committed, remove it from the active code and rotate it. Deleting the latest file alone does not remove it from Git history.
