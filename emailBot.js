// emailBot.js
// Reads unread emails, classifies intent, drafts/sends a response,
// escalates to a human when uncertain.
//
// Requires: npm install imapflow nodemailer dotenv
// Requires: a Gmail account with 2-Step Verification + an App Password
//           (same setup as the restaurant assistant project), AND
//           IMAP enabled in Gmail settings (Settings > Forwarding and
//           POP/IMAP > Enable IMAP)
// Run with: node emailBot.js

require('dotenv').config();
const express = require('express');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ===================================
// 1. EMAIL CONNECTIONS — one to READ, one to SEND
// ===================================
const imapClient = new ImapFlow({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD
  },
  logger: false
});

const smtpTransport = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD
  }
});

// ===================================
// 2. CLASSIFY INTENT — asks Gemini to categorize the email
// ===================================
async function classifyEmail(subject, body) {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GEMINI_API_KEY}` },
      body: JSON.stringify({
        model: 'gemini-3.6-flash',
        messages: [
          {
            role: 'system',
            content: `Classify this email into exactly one category: "simple_question" (a straightforward question you could confidently answer), "complaint" (customer is unhappy or frustrated), "urgent" (time-sensitive or serious issue), or "unclear" (you're not confident what they want, or it needs human judgment).

Respond with ONLY valid JSON, nothing else, in this exact shape:
{"category": "one_of_the_four_above", "confidence": "high or low", "reasoning": "one short sentence why"}`
          },
          { role: 'user', content: `Subject: ${subject}\n\nBody: ${body}` }
        ]
      })
    }
  );
  const data = await response.json();

  // Defensive check: if Gemini returned an error (rate limit, bad request, etc.)
  // instead of a normal response, don't crash — treat it as "unclear" so it
  // safely escalates instead of the whole batch dying.
  if (!data.choices || !data.choices[0]) {
    console.error('Unexpected API response:', JSON.stringify(data));
    return { category: 'unclear', confidence: 'low', reasoning: 'Classification failed — API error, needs manual review.' };
  }

  const raw = data.choices[0].message.content;
  const cleaned = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Could not parse classification JSON:', raw);
    return { category: 'unclear', confidence: 'low', reasoning: 'Classification response was not valid JSON — needs manual review.' };
  }
}

// ===================================
// 3. DRAFT A REPLY — only called for things the bot is confident about
// ===================================
async function draftReply(subject, body) {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GEMINI_API_KEY}` },
      body: JSON.stringify({
        model: 'gemini-3.6-flash',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful customer support assistant. Write a short, polite, professional email reply to the message below. Plain text only, no markdown, no subject line — just the reply body.'
          },
          { role: 'user', content: `Subject: ${subject}\n\nBody: ${body}` }
        ]
      })
    }
  );
  const data = await response.json();
  return data.choices[0].message.content;
}

// ===================================
// 4. SEND FUNCTIONS
// ===================================
async function sendReply(to, originalSubject, replyText) {
  await smtpTransport.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject: `Re: ${originalSubject}`,
    text: replyText
  });
  console.log(`Reply sent to ${to}`);
}

async function escalateToHuman(originalFrom, subject, body, reason) {
  await smtpTransport.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.ESCALATION_EMAIL,
    subject: `[NEEDS REVIEW] ${subject}`,
    text: `An incoming email needs human review.\n\nReason: ${reason}\n\nFrom: ${originalFrom}\nSubject: ${subject}\n\nOriginal message:\n${body}`
  });
  console.log(`Escalated to ${process.env.ESCALATION_EMAIL}: ${reason}`);
}

// ===================================
// 5. THE MAIN LOOP — checks inbox, processes each unread email
// ===================================
async function processInbox() {
  await imapClient.connect();
  const lock = await imapClient.getMailboxLock('INBOX');

  const activityLog = []; // tracks what happened this run, returned to the API caller

  try {
    // Search for unread messages only
    const unread = await imapClient.search({ seen: false });

    if (unread.length === 0) {
      return { checked: 0, log: ['No new emails.'] };
    }

    // SAFETY LIMIT: only process a small batch per run.
    const TEST_LIMIT = 3;
    const toProcess = unread.slice(0, TEST_LIMIT);
    activityLog.push(`Found ${unread.length} unread email(s) — processing ${toProcess.length}.`);

    for (const uid of toProcess) {
      const message = await imapClient.fetchOne(uid, { envelope: true, source: true });
      const subject = message.envelope.subject || '(no subject)';

      // Guard against system emails with no normal sender address
      if (!message.envelope.from || !message.envelope.from[0]) {
        activityLog.push(`Skipped "${subject}" — no readable sender address.`);
        continue;
      }
      const from = message.envelope.from[0].address;

      // Properly parse the raw MIME source (handles base64, multipart,
      // HTML vs plain text) instead of naive string splitting
      const parsed = await simpleParser(message.source);
      const bodyText = (parsed.text || parsed.html || '(no readable body)').slice(0, 3000);

      try {
        const classification = await classifyEmail(subject, bodyText);

        if (classification.category === 'simple_question' && classification.confidence === 'high') {
          const reply = await draftReply(subject, bodyText);
          await sendReply(from, subject, reply);
          activityLog.push(`Replied to "${subject}" from ${from} (${classification.category}).`);
        } else {
          await escalateToHuman(from, subject, bodyText, classification.reasoning);
          activityLog.push(`Escalated "${subject}" from ${from} — ${classification.reasoning}`);
        }
      } catch (err) {
        activityLog.push(`Failed to process "${subject}": ${err.message}`);
      }

      // Mark as read so it doesn't get processed again next run
      await imapClient.messageFlagsAdd(uid, ['\\Seen']);
    }
  } finally {
    lock.release();
  }

  await imapClient.logout();

  return { checked: activityLog.length, log: activityLog };
}

// ===================================
// 6. API — exposes the inbox check as a real endpoint
// ===================================
function startApiServer() {
  const app = express();

  // Triggers one inbox check on demand — call this from a frontend button,
  // a cron job, or a scheduler
  app.post('/api/check-inbox', async (req, res) => {
    try {
      const result = await processInbox();
      res.json(result);
    } catch (err) {
      console.error('Error processing inbox:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'Email bot API is running', monitoring: process.env.EMAIL_USER });
  });

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Email Bot API running on http://localhost:${PORT}`));
}

// ===================================
// 7. ENTRY POINT — API by default, or --cli for a one-off terminal run
// ===================================
if (process.argv.includes('--cli')) {
  processInbox()
    .then(result => console.log(result.log.join('\n')))
    .catch(err => console.error('Error processing inbox:', err.message));
} else {
  startApiServer();
}