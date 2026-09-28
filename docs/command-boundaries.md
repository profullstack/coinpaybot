# Comment command boundaries

Write invoice commands as plain, top-level Markdown paragraphs. The first
active line beginning with `/coinpay` followed by a space (or `/coinpay` alone)
is used. Up to three leading ASCII spaces and prose on earlier lines are allowed.
Descriptions are parsed from their original text, not rendered Markdown.

Commands in code fences, indented code, quotes (including lazy continuation
lines), lists, HTML blocks/comments, tables, inline code, links or emphasis
are examples, not executable instructions. Headings, including a command with
a setext underline (`---` or `===`), are deliberately ignored. An active plain
command after a code example can still run. Edited comments remain ignored.

Any comment containing parsed HTML is ignored as a whole, including inline
tags, HTML comments and collapsible details with blank lines. GitHub can render
Markdown paragraphs inside HTML containers invisibly; the bot does not guess
their visibility. Put a live command in a separate, HTML-free comment.

CRLF, CR and LF are line boundaries. Other whitespace inside a command is limited
to ASCII space and tab; invisible Unicode spaces and control separators are
rejected rather than folded into its flags. Unicode format controls (including
zero-width and bidi controls) and non-tab control characters are rejected too.
The first ambiguous active command rejects the body rather than falling through
to another command. This also applies to quoted text.
Rejected bodies are silently skipped without a bot reply. Descriptions containing
zero-width-joiner emoji sequences or directional marks are also skipped; use
plain text without those characters in an executable command.
Only ASCII spaces indent a command. Bodies above 65536 UTF-16 code units are
ignored before credential lookup or network requests. This is a processing
bound, not a promise to accept every GitHub comment.

Contribution balance/settlement commands retain their existing whole-comment
grammar. These boundaries do not change wallet selection, payment authorization,
invoice fees or settlement behavior.

Parser errors render untrusted tokens as inert code-span text, so malformed
commands cannot introduce clickable payment links or images into bot errors.
Reflected messages are capped at 500 characters before Markdown escaping.
