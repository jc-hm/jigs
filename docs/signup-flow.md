# Signup Flow

Technical reference for how users are created and onboarded. Two paths exist:
standard signup (self-registered, no templates) and invite signup (bootstrapped
with a copy of the inviter's templates).

---

## Standard Signup

```
1. User visits app (CloudFront SPA)

2. App calls GET /api/config
   ← { auth: { userPoolId, clientId, region } }

3. Signup form (shown only with ?invite=CODE or ?signup=jigs-open in URL)
   User enters email + password
   → Cognito.signUp(email, pw, [{ Name: "email", Value: email }])
   ← Cognito sends verification email

4. User enters verification code
   → Cognito.confirmSignUp(email, code)
   ← Cognito: PostConfirmation trigger fires (see below — no-op for non-invite)
   ← Cognito marks user CONFIRMED

5. App auto-signs in: Cognito.signIn(email, password)
   ← CognitoUserSession + ID token (stored in localStorage)

6. First authenticated API call
   → Authorization: Bearer {idToken}
   Auth middleware:
     a. Validates JWT (aws-jwt-verify, JWKS cached in Lambda memory)
     b. getUserByCognitoId(sub) — not found
     c. autoProvisionUser(sub, email):
          - Creates ORG#{orgId} record (10-char Crockford base32 ID)
          - Creates USER#{userId} record with GSI1 for Cognito lookup
          - Credits org with $10 starter balance (best-effort)
     d. Sets c.get("user") = { userId, orgId, role: "admin" }
   ← Request handled; user has zero templates
```

**DynamoDB records created on first API call:**
```
PK: ORG#{orgId}   SK: METADATA  → { name, region, plan: "free" }
PK: ORG#{orgId}   SK: USER#{userId}  GSI1PK: COGNITO#{sub}  → { email, role: "admin", cognitoId }
PK: ORG#{orgId}   SK: BALANCE  → { balanceUsd: 10, topUpsUsd: 10, spentUsd: 0, reportsLifetime: 0 }
```

---

## Invite Signup

Initiated when a user opens a link like `app.jigs.com?invite=A1B2C3D4`.

```
INVITE GENERATION (by existing user)
─────────────────────────────────────────────────────────────────────
Pilot → Profile page → "Invite a friend"
  [✓ Share my templates with whoever joins via this link]
  → POST /api/v1/invites  { shareTemplates: true }
  ← { code: "A1B2C3D4", expiresAt: "2026-04-21T..." }

DynamoDB record created:
  PK: INVITE#A1B2C3D4   SK: METADATA
  → { fromUserId, expiresAt, shareTemplates: true, TTL: <epoch> }

INVITE CLAIM (new user opens link)
─────────────────────────────────────────────────────────────────────
Browser loads app?invite=A1B2C3D4
  → Frontend captures code → sessionStorage "jigs:pendingInvite"
  → Strips param from URL (history.replaceState)
  → Shows signup form

User enters email + password
  → Cognito.signUp(email, pw, [
       { Name: "email", Value: email },
       { Name: "custom:invite_code", Value: "A1B2C3D4" }
     ])
  ← verification email sent

User enters verification code
  → Cognito.confirmSignUp(email, code)
              │
              └─► Cognito fires PostConfirmation trigger (sync, ≤5s budget)

POST-CONFIRMATION TRIGGER  (api/src/services/cognito-triggers.ts)
─────────────────────────────────────────────────────────────────────
  event.request.userAttributes["custom:invite_code"] = "A1B2C3D4"
  event.request.userAttributes.email = "friend@example.com"
  event.request.userAttributes.sub = "<cognitoSub>"

  → DynamoDB getInvite("A1B2C3D4")   validates: exists + not expired + shareTemplates
  → getUserByCognitoId(sub)           checks for existing record (idempotency guard)
  → autoProvisionUser(sub, email)     creates org + user → gets toUserId
  → Lambda.invoke(self, {             async, InvocationType: "Event"
       type: "bootstrap",             returns in <5ms — well within 5s trigger budget
       fromUserId: "<pilot>",
       toUserId:   "<new user>",
     })
  ← returns event to Cognito          Cognito marks user CONFIRMED

  Fault-tolerant: entire handler wrapped in try/catch; any error is logged
  and swallowed so the confirmation always succeeds.

BOOTSTRAP LAMBDA INVOCATION  (api/src/services/bootstrap.ts)
─────────────────────────────────────────────────────────────────────
  S3 ListObjectsV2 { prefix: "{fromUserId}/templates/" }
  S3 CopyObject × N  →  "{toUserId}/templates/{relPath}"
  Same-bucket server-side copy — no data egress, ~100ms per file.
  Logs: "[bootstrap] copied N template(s): X → Y"

FIRST API CALL  (user auto-signed in, app loads)
─────────────────────────────────────────────────────────────────────
  → any authenticated request
  Auth middleware: getUserByCognitoId(sub) → user found (provisioned in trigger)
  ← responds immediately, no added latency

  Frontend checks sessionStorage for "jigs:pendingInvite"
  → GET /api/invites/A1B2C3D4 (public, no auth)
  ← { valid: true, expiresAt: "..." }
  → Shows banner: "Your templates are being set up — they'll appear in a moment."
```

---

## Cognito Pool Configuration

Pool: `jigs-{stage}` (`cdk/lib/jigs-stack.ts`)

| Setting | Value |
|---|---|
| Self-signup | Enabled (but signup form hidden by URL guard) |
| Sign-in alias | Email only |
| Email verification | Auto (Cognito sends code) |
| Password policy | Min 8 chars, lowercase + digits |
| Custom attributes | `custom:invite_code` (mutable: false) |
| Triggers | `postConfirmation` → `jigs-api-{stage}` Lambda |

**Lambda trigger routing** (`api/src/index.ts`):
```ts
if (event.triggerSource === "PostConfirmation_ConfirmSignUp") → cognito-triggers.ts
if (event.type === "bootstrap")                              → bootstrap.ts
// else: normal HTTP via Hono
```

---

## Access Control (signup visibility)

The signup form is hidden by default. URL params control visibility:

| URL | Signup shown | Template bootstrap |
|---|---|---|
| (nothing) | No — login only | — |
| `?invite=CODE` | Yes | Yes (if invite valid + shareTemplates) |
| `?signup` (any value) | Yes | No |

`signup` is an undocumented param checked client-side (`params.has("signup")`);
the value is ignored. Not a security boundary — Cognito self-signup is technically
open. This just prevents casual discovery of the registration form during the
invite-only pilot.

---

## Invite Record Schema

```
PK: INVITE#{code}     (10-char Crockford base32)
SK: METADATA
fromUserId: string    user ID of the inviter (not org ID)
expiresAt: string     ISO-8601; checked eagerly in getInvite()
shareTemplates: bool  if false, invite is valid but no templates are copied
TTL: number           Unix epoch seconds (DynamoDB auto-expire)
```

No `maxUses` field — expiry is the only gate. An invite link can be shared
with any number of people until it expires (default 7 days).
