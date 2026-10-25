# Hymenia Server API

## Authentication

- Registration: `POST /api/auth/register`
- Email verification: `POST /api/account/email/verify`
- Login: `POST /api/auth/login`
- Passkey login: `POST /api/auth/passkey/login/options`, then `/api/auth/passkey/login/verify`
- Passkey registration: `POST /api/auth/passkey/register/options`, then `/api/auth/passkey/register/verify`
- Captcha configuration: `GET /api/auth/hcaptcha`
- App tokens: `Authorization: App <app-token>`

## Endpoints

- `GET /.well-known/hymenia`*
- `GET /api/auth/hcaptcha`*
- `POST /api/auth/register`*
- `POST /api/auth/login`*
- `POST /api/auth/passkey/register/options`
- `POST /api/auth/passkey/register/verify`
- `POST /api/auth/passkey/login/options`*
- `POST /api/auth/passkey/login/verify`*
- `GET /api/account/profile`
- `PATCH /api/account/profile`
- `POST /api/account/avatar`
- `POST /api/account/avatar/delete`
- `POST /api/account/password`
- `POST /api/account/delete`
- `GET /api/account/email`
- `POST /api/account/email`
- `POST /api/account/email/verify`
- `GET /api/profile/:username`*
- `GET /api/avatar/:username`*
- `PATCH /api/users/:username/roles`
- `GET /api/spaces`
- `GET /api/spaces/discover`
- `POST /api/spaces`
- `POST /api/spaces/:spaceId/join`
- `GET /api/spaces/:spaceId/members`
- `POST /api/spaces/:spaceId/members`
- `POST /api/spaces/:spaceId/invites`
- `GET /api/spaces/:spaceId/invites`
- `DELETE /api/spaces/:spaceId/invites/:inviteId`
- `POST /api/invites/:code/accept`
- `GET /api/spaces/:spaceId/chats`
- `POST /api/spaces/:spaceId/chats`
- `GET /api/messages?chat_id=...`
- `GET /messages?chat_id=...`
- `POST /api/messages`
- `PATCH /api/messages/:messageId`
- `DELETE /api/messages/:messageId`
- `POST /api/chats/:chatId/attachments`
- `GET /api/attachments/:attachmentId`
- `POST /api/apps`
- `GET /api/apps`
- `DELETE /api/apps/:appId`
- `POST /api/apps/:appId/regenerate`
- `POST /api/apps/:appId/invites`
- `GET /api/apps/:appId/invites`
- `DELETE /api/apps/:appId/invites/:inviteId`
- `GET /api/applications/:code`
- `POST /api/applications/:code/accept`
- `POST /api/apps/:appId/webhooks`
- `GET /api/apps/:appId/webhooks`
- `DELETE /api/apps/:appId/webhooks/:webhookId`
- `POST /api/webhooks/:webhookId/:token`*
- `PATCH /api/webhooks/:webhookId/:token/messages/:messageId`*
- `DELETE /api/webhooks/:webhookId/:token/messages/:messageId`*
- `POST /api/voice/token`
- `GET /health`*
- `GET /livekit/rtc/v1/validate`*
- `GET /livekit/rtc/validate`*
- `ws://127.0.0.1:9070/ws`
- `ws://127.0.0.1:9070/livekit/rtc/v1`
- `ws://127.0.0.1:9070/livekit/rtc`

All HTTP endpoints except the ones marked with a * require a bearer or app token.
Creating/joining spaces, sending messages, and uploading attachments require verified email for user accounts.

### Webhooks

uhh hazel can fill this one out 😂