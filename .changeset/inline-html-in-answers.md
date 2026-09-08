---
'codsh-bundle': patch
---

feat(markdown): render the inline HTML an answer carries — `<font color>`, `<span style>`, emphasis tags, `<br>`, entities

Models reach for `<font color="green">+757.22 USDT</font>` far more often than for a Markdown way to colour a figure, and the tag printed literally in the transcript. Answers now render the inline HTML they carry: `<font color>` and `<span style="color…; font-weight…">` paint the text — an ANSI colour name in the terminal's own palette, so `green` matches the theme's success colour, and any other name, `#hex`, or `rgb()` in truecolor, the nearest 256-colour entry, or the nearest of sixteen, whichever the terminal has; `<b>`/`<strong>`, `<i>`/`<em>`, `<u>`, `<s>`/`<del>`, `<code>`/`<kbd>`, and `<mark>` map onto the theme's roles; `<sub>`, `<sup>`, `<small>`, and a bare `<span>` keep their text; `<br>` starts a new row, under the text of a list item and inside a table cell; `&amp;`-style and numeric entities decode outside code spans. Markdown inside a tag and a tag inside emphasis both render, with the outer style kept open past the tag's own reset. Anything else — `<div>`, an unclosed or unknown tag, a `<T>` in prose, a tag inside a code span — stays exactly as written, and off a TTY the styled tags are stripped so a piped transcript reads plainly.
