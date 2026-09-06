# Email/Inbox Automation - API

Reads unread emails from a real Gmail inbox, classifies each one's
intent, drafts and sends a reply for straightforward questions, and
escalates (forwards with context) to a human for anything uncertain,
a complaint, or urgent. Runs as a real API - trigger an inbox check
on demand instead of it running automatically on load.

## Live deployment

This is deployed and running at:
```
https://emailbot-8yjj.onrender.com
```

**Important - Render free tier "cold starts":** on Render's free tier,
a web service spins down after a period of no traffic and takes 30-60
seconds to wake back up on the next request. The very first call after
inactivity will feel slow or may briefly time out - this is normal
behavior for the free tier, not a bug. Just try again if the first
call fails, and it'll respond quickly on the next attempt.

## How it works

1. **Read** - connects to your Gmail inbox via IMAP, finds unread emails
2. **Parse** - uses `mailparser` to properly decode real email content
   (handles base64, multipart messages, HTML vs plain text - not just
   naive string splitting)
3. **Classify** - sends the subject + body to Gemini, asks it to categorize:
   `simple_question`, `complaint`, `urgent`, or `unclear` - with a
   confidence level
4. **Decide** - only `simple_question` + `high confidence` gets an
   automatic reply. Everything else gets escalated instead of guessed at
5. **Act** - either drafts and sends a reply, or forwards the original
   email plus the AI's reasoning to a human review address
6. Marks each processed email as read, so it isn't processed twice

This mirrors the human-in-the-loop pattern from earlier in your
roadmap: the bot only acts confidently when it's genuinely confident,
and hands off everything else.

## Setup (for running your own copy)

1. **Generate an App Password**: Google Account > Security > 2-Step
   Verification > App Passwords (Gmail IMAP is on by default now, no
   separate toggle needed)

2. Copy `.env.example` to `.env` and fill in:
   - `GEMINI_API_KEY`
   - `EMAIL_USER` / `EMAIL_APP_PASSWORD` - the inbox being monitored
   - `ESCALATION_EMAIL` - where uncertain emails get forwarded
   - `PORT` - only matters locally; Render assigns its own port
     automatically in production, which the code already handles

3. **If deploying your own copy to Render**: don't upload a `.env`
   file - instead, add each variable individually under your Render
   service's Environment settings tab. This keeps real credentials
   out of your GitHub repo.

## API Reference (for frontend developers integrating this)

**Base URL:** `https://emailbot-8yjj.onrender.com`

CORS is enabled - this API can be called directly from browser-based
frontends on any domain.

### `POST /api/check-inbox`

Triggers one inbox check - reads unread emails, classifies them,
replies or escalates as appropriate. Takes no request body.

**Success response - `200 OK`:**
```json
{
  "checked": 3,
  "log": [
    "Found 5 unread email(s) - processing 3.",
    "Replied to \"Store hours?\" from customer@example.com (simple_question).",
    "Escalated \"Refund request\" from angry@example.com - customer is frustrated about a delayed refund"
  ]
}
```
If there's nothing new: `{"checked": 0, "log": ["No new emails."]}`

**Error response - `500 Internal Server Error`:**
```json
{ "error": "description of what failed" }
```

### `GET /api/health`

Confirms the service is running and shows which inbox it's watching.

**Response - `200 OK`:**
```json
{ "status": "Email bot API is running", "monitoring": "youraddress@gmail.com" }
```

### Minimal frontend integration example

```javascript
async function checkInbox() {
  const res = await fetch('https://emailbot-8yjj.onrender.com/api/check-inbox', {
    method: 'POST'
  });

  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.error || 'Request failed');
  }

  const data = await res.json();
  return data.log; // array of strings describing what happened
}
```

The bot doesn't run automatically on a timer by default - it waits for
something to call `/api/check-inbox`. That means you (or something
else) need to trigger it. Real ways this gets used in practice:

**1. Manually, whenever you want to check the inbox:**
```powershell
Invoke-RestMethod -Uri "https://emailbot-8yjj.onrender.com/api/check-inbox" -Method POST
```
Returns a JSON log of what happened this run.

**2. On a schedule, automatically** - this is the realistic production
setup. Use a free scheduling service (like cron-job.org, or Render's
own paid Cron Jobs feature) to call this same URL every 5-15 minutes,
so the inbox gets checked continuously without you doing it by hand.

**3. Triggered by another automation** - e.g. an n8n workflow with a
Schedule node that calls this URL on a timer, or a Zapier/Make.com
automation doing the same.

**Health check** (confirm it's alive and see which inbox it's watching):
```powershell
Invoke-RestMethod -Uri "https://emailbot-8yjj.onrender.com/api/health"
```

## Local development (before deploying changes)

Test locally first before pushing changes to the live URL:
```
npm install
node emailBot.js
```
Then call `http://localhost:<PORT>/api/check-inbox` instead of the
live URL, exactly the same way.

## IMPORTANT - test with a real test inbox, not your main one

The very first time you run this, it will find whatever is currently
unread in your inbox - which for most real Gmail accounts means
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
automatically on a schedule instead of calling it manually - either
with `node-cron` inside this same project, or by having an external
service (like a cron job on Render, or an n8n workflow) call this
endpoint every few minutes.

## Rate limits

Same as the research agent project - the free Gemini tier has a daily
request cap that varies by model name. If you see repeated
"Classification failed - API error" results, check the server's
terminal output for the specific error (quota exceeded vs temporary
server overload).

## Known limitations (intentional, for a learning project)

- No handling for email threads/conversation history - each email is
  classified independently
- No de-duplication protection if the bot crashes mid-processing and
  re-runs - a real system would track processed message IDs in a
  database, not just rely on the "mark as read" flag
- No retry/backoff on temporary API failures
