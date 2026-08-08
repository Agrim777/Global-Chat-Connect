# Global Chat Connect — Safety Specification

This bot is an anonymous human-to-human text-chat service for adults. It is not a dating bot, does not guarantee a gender match, and does not verify a user's gender or identity.

## Required behavior

- On `/start`, show the Disclaimer and Privacy Policy before profile creation.
- Require an explicit 18+ and consent confirmation. Reject users who do not agree.
- Gender is collected once and locked after signup. There is no gender-edit route.
- Female accounts are free. Male accounts must purchase Telegram Stars access: 150 for 2 weeks, 250 for 1 month, or 1000 lifetime.
- Never create, imply, or disclose a fake AI persona. There is no AI/free trial chat.
- Relay text only. Block all media and immediately explain that this is for girls' safety and to reduce fake-photo/morphing/extortion risks.
- Block requests to move to Instagram, personal Telegram DMs, phone, or other private contact. Send the scam warning before any interaction continues.
- Provide `/report` and a Report User button. Store one report per reporter/reported pair; repeated reports notify the admin for review.
- Notify `ADMIN_TELEGRAM_ID` when a completed female profile joins. State clearly that gender is self-declared and unverified.

## Legal copy

The bot shows an India-focused privacy policy and disclaimer referencing the adult-only rule, data minimization, user deletion, safety reporting, no guarantee of gender matching, no dating purpose, no media sharing, and no responsibility for information voluntarily shared outside the bot. The copy must be reviewed by qualified local counsel before launch.
