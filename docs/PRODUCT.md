# Jigs — Product

## What Jigs Is

Jigs is a template-filling system powered by generative AI. Users describe what they need in plain language (text or voice), and the system finds the right template, fills it out, and streams the result back in seconds.

The first vertical is **radiology reporting**: a radiologist says "left knee MRI, ACL complete tear, small joint effusion" and gets a complete, structured report ready to paste into their system.

But Jigs is not a radiology product. It is a **generic template-filling engine** that can serve any domain where structured documents are generated from brief inputs — legal, insurance, clinical notes, inspections, compliance. The radiology vertical validates the core loop; the architecture is intentionally domain-agnostic.

## Who Uses It

**End users** (e.g., radiologists) — their day is filling out the same types of reports, with variations. They want to describe a case quickly and get a correct, formatted report with minimal effort. They might use it 10–50 times a day. Speed and accuracy matter more than features.

**Admin users** (e.g., department leads, practice managers) — they configure the system for their team. They upload and organize templates, manage users, and monitor usage/billing. They care about control, cost visibility, and making sure the templates match their institutional standards.

**Future: platform users** — organizations that want to plug Jigs into their own workflows via API. This is a later concern, but the architecture should not make it hard.

## Core Workflows

### Fill (the main loop)
User inputs a brief description → system matches the right template → AI fills it out → result streams back. This is 90% of the product surface. It must be fast (streaming, first token in ~1 second), low-friction (no template selection UI needed — the AI picks), and conversational (user can refine without starting over).

### Refine
User says "change the effusion to moderate" or "add a note about prior surgery" → system modifies the current report without regenerating from scratch. This keeps the radiologist in flow.

### Re-select
User says "no, this should be a CT not an MRI" → system picks a different template and re-fills. Correcting a wrong match should be as easy as saying so.

### Template management
Admin uploads templates — individually or in bulk. Templates are text files stored in S3, organized by a taxonomy in the skill record. Users can fork templates to customize their own versions (e.g., "I always want a bone marrow section in my knee reports").

### Template evolution
Over time, usage patterns inform template improvements. A user saying "add a section for X" can become a suggested template update for the admin to review. The system should get better as it's used.

## What Jigs Is NOT

- **Not a general AI assistant.** Users cannot ask arbitrary questions. The system handles four specific intents: fill, refine, re-select, and template update. Everything else is out of scope.
- **Not a medical device.** Jigs generates draft reports for human review. The radiologist always reviews and approves before the report enters their system. Jigs does not diagnose, recommend, or make clinical decisions.
- **Not a data store for patient information.** Report content is never persisted on our servers. Session state is client-side. We store only aggregated usage counters. When report history is eventually added, it will use client-side encryption so we cannot read the content.

## Business Model

**Per-report pricing** — simple for customers to understand. The cost of generating a report is dominated by AI inference (~$0.02–0.05 per report). We charge a flat fee per report that covers AI cost + infrastructure + margin.

**Free tier** — 1 report per day per user, no payment method required. Low enough to prevent abuse, high enough to let someone try it meaningfully. The goal is zero-friction trial: sign up with Google, fill a report, see if it works for you.

**Paid plans** — monthly subscription with included reports + overage pricing. EUR first (Spain market). Multi-currency (USD, etc.) added as markets expand.

**Cost transparency** — internally, every report tracks its actual AI cost (input/output tokens × model pricing). This lets us set prices that are always profitable per-report, even at low volumes.

## First Market

**Spain.** The first customers are radiologists in Spanish healthcare. This means:

- Infrastructure starts in **eu-central-1** (Frankfurt) — closest Bedrock region to Spain.
- Pricing in **EUR**.
- Voice input must work well with **Spanish** medical terminology (Web Speech API for v1, AWS Transcribe with medical model if accuracy is insufficient).
- UI should be prepared for **localization** but launches in English first.
- **Data residency** concerns are real in EU healthcare — the no-stored-content approach sidesteps most of this.

## Multi-Channel Vision

The web app is the primary channel, but the fill workflow is simple enough to work over lighter interfaces:

- **Telegram bot** — radiologist sends a text message, gets a report back. Account linking via a one-time web login. Useful for quick fills without opening a browser.
- **API** — for organizations that want to embed template filling into their own software (EHR systems, mobile apps, internal tools).
- **Voice-first** — the web app already supports voice input via the browser. A future dedicated voice interface (or integration with dictation systems radiologists already use) could make this even more seamless.

The architecture supports this by keeping the AI and template logic in the API layer, decoupled from any specific client.

## Guiding Principles

1. **Speed over features.** A radiologist using Jigs should be faster than typing the report themselves. If any interaction adds friction or delay, question whether it's necessary.

2. **Bounded AI.** The system does specific things well, not everything poorly. Four intents, clear guardrails, predictable behavior.

3. **No data we don't need.** If we don't store patient data, we don't have to secure patient data. Start with the minimum and add storage only with proper encryption and consent.

4. **Cost-aware by default.** Every architectural decision considers the bootstrapping reality: this might serve 10 users or 10,000. The system should cost near-zero at low scale and grow linearly.

5. **Domain-agnostic core.** The skill/template model should make adding a new vertical (legal, insurance, compliance) a matter of configuration, not code changes.
