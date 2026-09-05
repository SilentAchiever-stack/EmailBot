# Email/Inbox Automation — API

Reads unread emails from a real Gmail inbox, classifies each one's
intent, drafts and sends a reply for straightforward questions, and
escalates (forwards with context) to a human for anything uncertain,
a complaint, or urgent. Runs as a real API — trigger an inbox check
on demand instead of it running automatically on load.

## How it works

1. **Read** — connects to your Gmail inbox via IMAP, finds unread emails
2. **Parse** — uses `mailparser` to properly decode real email content
   (handles base64, multipart messages, HTML vs plain text — not just
   naive string splitting)
3. **Classify** — sends the subject + body to Gemini, asks it to categorize:
   `simple_question`, `complaint`, `urgent`, or `unclear` — with a
   confidence level
4. **Decide** — only `simple_question` + `high confidence` gets an
   automatic reply. Everything else gets escalated instead of guessed at
5. **Act** — either drafts and sends a reply, or forwards the original
   email plus the AI's reasoning to a human review address
6. Marks each processed email as read, so it isn't processed twice

This mirrors the human-in-the-loop pattern from earlier in your
roadmap: the bot only acts confidently when it's genuinely confident,
and hands off everything else.

## Setup

1. **Generate an App Password**: Google Account > Security > 2-Step
   Verification > App Passwords (Gmail IMAP is on by default now, no
   separate toggle needed)

2. Copy `.env.example` to `.env` and fill in:
   - `GEMINI_API_KEY`
   - `EMAIL_USER` / `EMAIL_APP_PASSWORD` — the inbox being monitored
   - `ESCALATION_EMAIL` — where uncertain emails get forwarded
   - `PORT` — pick a unique port if running alongside other local
     projects (this defaults to 3001)

3. Install and run:
   ```
   npm install
   node emailBot.js
   ```
   You should see: `Email Bot API running on http://localhost:<PORT>`

## Calling the API

**Trigger an inbox check** (POST) — checks for unread emails and
processes up to 3 of them:
```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/check-inbox" -Method POST
```
Returns a JSON log of what happened — which emails were replied to,
which were escalated, and why.

**Health check** (GET):
```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/health"
```

**One-off CLI test** (no API, just a quick terminal run):
```
node emailBot.js --cli
```

## IMPORTANT — test with a real test inbox, not your main one

The very first time you run this, it will find whatever is currently
unread in your inbox — which for most real Gmail accounts means
years of old newsletters, notifications, and system emails, not clean
test cases. Running the bot against your real inbox means it will
genuinely try to auto-reply to real senders.

**Strongly recommended**: create a separate, dedicated Gmail account
just for this bot to monitor, so you fully control what test emails
go into it.

A safety limit (`TEST_LIMIT = 3` inside `emailBot.js`) caps how many
emails get processed per check, specifically to avoid accidentally
processing your entire inbox at once.

## Running this on a schedule (not just on-demand)

Since this is now an API, you can trigger `/api/check-inbox`
automatically on a schedule instead of calling it manually — either
with `node-cron` inside this same project, or by having an external
service (like a cron job on Render, or an n8n workflow) call this
endpoint every few minutes.

## Rate limits

Same as the research agent project — the free Gemini tier has a daily
request cap that varies by model name. If you see repeated
"Classification failed — API error" results, check the server's
terminal output for the specific error (quota exceeded vs temporary
server overload).

## Known limitations (intentional, for a learning project)

- No handling for email threads/conversation history — each email is
  classified independently
- No de-duplication protection if the bot crashes mid-processing and
  re-runs — a real system would track processed message IDs in a
  database, not just rely on the "mark as read" flag
- No retry/backoff on temporary API failures