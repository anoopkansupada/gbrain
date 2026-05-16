---
name: intro-email
version: 1.0.0
description: |
  Draft introduction emails in Anoop's exact voice. Two formats — outbound intro
  (Anoop introduces party A to party B) and inbound reply (Anoop received a
  warm intro and responds). Pattern derived from 17+ sent emails in Gmail.
triggers:
  - "draft intro email"
  - "intro email"
  - "warm intro"
  - "introduce X to Y"
  - "respond to boardy"
  - "/intro"
tools:
  - get_page
  - search
mutating: false
---

# Intro Email — Anoop's voice

This skill writes intro emails the way Anoop already writes them. **No invention. No softening. No "I hope this finds you well."** Match the established pattern exactly.

## The two formats

### Format 1 — Outbound intro

Anoop is introducing a company/person he recently met to one of his existing contacts. He believes the new party could be a useful resource. This is the most common intro pattern.

**Subject line:** `<Company A> <> <Company B>` — literal `<>` between the two names. No "Intro:" prefix. No "Connecting".

**Body template:**

```
Hi <First Name>,

I wanted to introduce you to <Company A> - I recently connected with them and thought of you right away, they could be a great resource.

About them: <One-line value proposition. Plain English. No marketing fluff.>

Anoop
```

**To field:** the new company's contact(s). **CC field:** the existing contact (`First.Last@theircompany.com`). The CC structure means the existing contact gets the intro and the new company gets the warm credibility from Anoop's name.

**Verbatim phrases — DO NOT MODIFY:**
- `I wanted to introduce you to`
- `I recently connected with them and thought of you right away, they could be a great resource.`
- `About them:`

**Variation: when Anoop initiates from a recent network add**, the framing is "thought of you right away" — this signals it's a heat-of-the-moment intro, not a long-deliberated one. Keep that energy.

### Format 2 — Reply to inbound warm intro

Anoop received an intro (often from Boardy, sometimes from a real human). He needs to respond, acknowledge the intro-maker, greet the new contact, and book the meeting.

**Subject line:** keep the existing thread subject — just hit Reply.

**Body template:**

```
Thanks <Intro-Maker First Name>. [Optional: Moving you to bcc to spare your inbox.]

<New Contact First Name>,

<1-3 word pleasure-to-meet line.> <Optional 1-sentence excitement.>

https://calendly.com/anoopkansupada

Anoop
```

**Compressed single-line variant** (when context is already clear from the inbound message):

```
Lets chat. https://calendly.com/anoopkansupada
```

**Verbatim pleasure-to-meet lines Anoop actually uses** (pick one, don't invent new):
- `Pleasure to meet.`
- `Pleasure to meet you.`
- `Great to meet.`
- `Excited about this conversation.`

**Verbatim CTA lines Anoop uses:**
- `Grab a time here:`
- `Grab a time:`
- `Lets chat.`
- `Lets chat!`
- `Lets grab time`
- `Would love to trade notes.`

Always followed by `https://calendly.com/anoopkansupada` on its own line or inline.

### Format 3 — Three-way intro Anoop initiates (less common but happens)

When Anoop knows both parties and is creating the connection from scratch (no prior pitch from either side). Mid-length, peer-to-peer.

**Subject line:** `<First Name A> <> <First Name B>` (first names not company names).

**Body template:**

```
<Name A>, <Name B> — wanted to put you two in touch.

<Name A> — <one-line who they are + what they do>.

<Name B> — <one-line who they are + what they do>.

<One sentence why this connection makes sense — the overlap.>

Grab time and trade notes.

Anoop
```

**Verbatim phrases for Format 3:**
- `wanted to put you two in touch.`
- `Grab time and trade notes.` (or `Grab time.`)

No "I'm putting you two in touch because..." (too formal). State the overlap as a fact, not as justification.

## Voice characteristics — apply to all three formats

- **Lowercase, casual register.** "Lets chat" not "Let's chat". "Pleasure to meet" not "It was a pleasure to meet you."
- **Space-hyphen-space** ` - ` for dashes. NOT em-dashes (—). NOT en-dashes (–).
- **No preamble.** Skip "I hope this finds you well", "Hope you're having a great week", "Wanted to circle back".
- **No hedging.** "Could be helpful" → cut. "Thought you'd find this interesting" → cut. State the value directly.
- **Calendly is the default CTA** for inbound replies. For outbound intros, no CTA — the receiving party initiates contact.
- **Signoff is `Anoop`** on a line by itself. The Gmail signature handles the rest.
- **Sentence fragments are fine.** "Excited to chat." "Lets grab time."
- **One-line bodies are fine** for the reply format. The shorter the better.

## Anti-patterns — never produce these

- "I hope this email finds you well"
- "I wanted to reach out to introduce"
- "I'm writing to introduce" (not how Anoop opens)
- "Cross-jurisdiction regulatory questions Sam is hearing from his clients almost always have a US-touch element you'd have a view on" (overlong, hedging — past Claude draft, do not replicate)
- "Best regards" / "Best" / "Sincerely" (signoff is just `Anoop`)
- Em-dashes — use ` - ` instead
- Bullet lists in the body (Anoop doesn't use them in intros)
- Apologies for length
- Multiple paragraphs explaining the relevance — one sentence max

## Inputs the skill expects

- `format`: `outbound` | `reply` | `three-way`
- `intro_target`: who is being introduced (name + company + 1-line description)
- `recipient`: who gets the intro (name + company)
- `intro_maker` (only for `reply`): who made the intro
- `value_prop`: 1-line description of what the intro_target does — plain English

## Output

Plain-text email body matching the format above. No markdown, no commentary, no "here's the draft" preamble. Just the email body, ready to paste into Gmail.

## Validation checks before output

1. Subject line uses `<>` separator (formats 1, 3) or original thread subject (format 2)
2. No em-dashes anywhere in the body
3. "Lets" not "Let's" if the casual form is used
4. Calendly URL is `https://calendly.com/anoopkansupada` (no variations)
5. Signoff is `Anoop` on its own line — no "Best", no "Thanks Anoop", no "Cheers"
6. For outbound: contains the verbatim "I recently connected with them and thought of you right away, they could be a great resource."
7. For reply: starts with "Thanks <Intro-Maker>." if there was an intro-maker

## Source patterns (audit trail)

Pattern extracted from these Gmail threads (all `from:anoop.kansupada@gmail.com`):

- Tie <> Dpvs.io · 2026-03-20
- Tie <> Forbes · 2026-03-20
- Coverage <> Bazbaz development · 2026-03-20
- Charlemagne Labs <> Depthmap · 2026-03-20
- Charlemagne Labs <> Forbes · 2026-03-20
- Shipplug <> Toweropticalco · 2026-03-20
- Financialese <> Toweropticalco · 2026-03-20
- Warp <> Toweropticalco · 2026-03-19
- Slash <> Toweropticalco · 2026-03-19
- GrowthPair <> Toweropticalco · 2026-03-19
- Shiptrac <> Oneofnone · 2026-03-19
- Re: Boardy Intro: Anoop + Pintu · 2026-04-20
- Re: Boardy Intro: Anoop + Remy · 2026-04-20
- Re: Boardy Intro: Anoop + A.Anirudh · 2026-04-20
- Re: Boardy Intro: Yoriko + Anoop · 2026-04-20
- Re: Boardy Intro: Zia + Anoop · 2026-04-18
- Re: Boardy Intro: Jielun + Anoop · 2026-04-08
- Re: Boardy Intro: Matthew + Anoop · 2026-03-27
- Re: Boardy Intro: Pascal + Anoop · 2026-04-01

Pattern is stable across 11+ outbound intros and 8+ inbound replies over ~2 months. High confidence.

## When to use

- User asks to "draft an intro" / "write an intro email" / "respond to this Boardy intro"
- User pastes an inbound intro thread and asks for a response
- The brief-pipeline produces an "intro" task (e.g., the Daniel Sacks task from the 2026-05-13 Samuel call)
- Operator is about to write an intro email themselves — auto-load this skill to keep voice consistent

## When NOT to use

- Cold outbound prospecting (different problem — uses the DataHive drafter)
- Internal team comms (different voice)
- Long-form business correspondence (this skill is for SHORT intros only)
- Anything where the message needs to be longer than 100 words — that's not an intro, it's a memo
